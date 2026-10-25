/**
 * Signing in with a sign-in provider (Google, GitHub, a generic OIDC
 * issuer), end to end through the real Better Auth configuration
 * (createAuth) on a migrated SQLite database, against mock providers
 * (src/test/mock-sign-in-providers.ts): what the sign-in page is offered,
 * who gets in (members, invitations, strangers, unverified emails,
 * deactivated users, an unclaimed gateway, the hosted gateway's open
 * sign-up), account linking, the ID token checks, turning password sign-in
 * off, and the outer ring staying in front.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const workerEnv = vi.hoisted(
  () =>
    ({
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      GATEWAY_URL: "https://gateway.example.com",
      BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
      DB: {},
    }) as Record<string, unknown>,
);

vi.mock("cloudflare:workers", () => ({
  env: workerEnv,
  waitUntil: () => undefined,
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(testDb), schema };
});
// createAuth builds its adapter on D1; hand it the SQLite database instead.
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => testDb.current }));
// Outside a TanStack request there is no response to put cookies on.
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuth } from "@/auth";
import {
  accounts,
  apps,
  invitations,
  members,
  organizations,
  ownerSetupTokens,
  sessions,
  userAppAccess,
  users,
} from "@/db/schema";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { InvitationService } from "@/server/services/InvitationService";
import { SetupService } from "@/server/services/SetupService";
import {
  createMockAccess,
  MOCK_ACCESS_ENV,
  type MockAccess,
} from "@/test/mock-access";
import {
  createMockSignInProviders,
  MOCK_SIGN_IN_ENV,
  type MockSignInIdentity,
  type MockSignInProviders,
} from "@/test/mock-sign-in-providers";
import { createTestDb } from "@/test/sqlite-db";
import { clearJwksClientsForTests } from "../cloudflare-access/jwt";
import { resetSignInProviderProblemsForTests } from "./config";
import { clearOidcDiscoveryForTests } from "./oidc-provider";

const GATEWAY_URL = "https://gateway.example.com";
const BASE_ENV = { ...workerEnv };
const OWNER = {
  name: "Owner",
  email: "owner@acme.com",
  password: "owner-password-1",
};

/** Replace the sign-in settings (Worker secrets) for this test. */
function useEnv(settings: Record<string, string>) {
  for (const key of Object.keys(workerEnv)) delete workerEnv[key];
  Object.assign(workerEnv, BASE_ENV, settings);
}

/** One browser's cookies. */
class Browser {
  private readonly cookies = new Map<string, string>();

  store(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired =
        !value ||
        attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

async function send(
  url: string,
  options: {
    method?: string;
    browser?: Browser;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const cookie = options.browser?.header();
  const response = await createAuth().handler(
    new Request(url, {
      method: options.method ?? "GET",
      headers: {
        origin: GATEWAY_URL,
        ...(cookie ? { cookie } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
  options.browser?.store(response);
  return response;
}

function api(path: string, options: Parameters<typeof send>[1] = {}) {
  return send(`${GATEWAY_URL}/api/auth${path}`, options);
}

let db: TestDb;
let mock: MockSignInProviders;
let access: MockAccess;

async function userByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user;
}

async function membershipsOf(email: string) {
  const user = await userByEmail(email);
  if (!user) return [];
  return db.select().from(members).where(eq(members.userId, user.id));
}

async function accountsOf(email: string, providerId: string) {
  const user = await userByEmail(email);
  if (!user) return [];
  return db
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.userId, user.id), eq(accounts.providerId, providerId)),
    );
}

/** Claim the gateway as OWNER (a password account, its email not verified). */
async function claimGateway() {
  await db.insert(ownerSetupTokens).values({
    id: "link-1",
    kind: "claim",
    tokenHash: createHash("sha256").update("est_setup").digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  return SetupService.claimOwner({ token: "est_setup", ...OWNER });
}

async function passwordSignIn(
  browser: Browser,
  email: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return api("/sign-in/email", {
    method: "POST",
    browser,
    body: { email, password },
    headers,
  });
}

/** A member whose email is verified. */
async function seedVerifiedMember(
  organizationId: string,
  email: string,
  role = "member",
): Promise<string> {
  const id = `user-${email}`;
  await db
    .insert(users)
    .values({ id, name: email, email, emailVerified: true });
  await db.insert(members).values({
    id: `member-${email}`,
    organizationId,
    userId: id,
    role,
    createdAt: new Date(),
  });
  return id;
}

async function seedDefaultApp(organizationId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(apps).values({
    id,
    organizationId,
    appSlug: "handbook",
    name: "Handbook",
    description: "Available to everyone",
    isDefault: true,
  });
  return id;
}

async function grantedAppsOf(userId: string): Promise<string[]> {
  const grants = await db
    .select()
    .from(userAppAccess)
    .where(eq(userAppAccess.userId, userId));
  return grants.map((grant) => grant.appRowId);
}

async function inviteAs(
  owner: { organizationId: string; userId: string },
  email: string,
  role: "member" | "admin" = "member",
) {
  const ownerBrowser = new Browser();
  expect(
    (await passwordSignIn(ownerBrowser, OWNER.email, OWNER.password)).status,
  ).toBe(200);
  return InvitationService.invite(
    { orgId: owner.organizationId, userId: owner.userId, role: "owner" },
    new Headers({ cookie: ownerBrowser.header() }),
    { email, role },
  );
}

/** Click "Continue with <provider>": Better Auth's authorization URL. */
async function start(
  browser: Browser,
  provider: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return api("/sign-in/social", {
    method: "POST",
    browser,
    body: {
      provider,
      callbackURL: "/",
      errorCallbackURL: "/sign-in",
      ...body,
    },
    headers,
  });
}

async function authorizationUrl(
  browser: Browser,
  provider: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await start(browser, provider, body, headers);
  expect(response.status).toBe(200);
  const { url, redirect } = (await response.json()) as {
    url: string;
    redirect: boolean;
  };
  expect(redirect).toBe(true);
  return url;
}

/** Log in at the provider as `identity` and follow the redirect back. */
function finish(
  browser: Browser,
  url: string,
  identity: MockSignInIdentity,
  headers: Record<string, string> = {},
): Promise<Response> {
  return send(mock.authorize(url, identity).back.toString(), {
    browser,
    headers,
  });
}

/** Start and finish a sign-in with `provider` as `identity`. */
async function signIn(
  browser: Browser,
  provider: string,
  identity: MockSignInIdentity,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = await authorizationUrl(browser, provider, {}, headers);
  return finish(browser, url, identity, headers);
}

function errorOf(response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  return new URL(location, GATEWAY_URL).searchParams.get("error");
}

async function sessionOf(browser: Browser) {
  return (await api("/get-session", { browser })).json() as Promise<{
    user: { id: string; email: string };
  } | null>;
}

beforeEach(async () => {
  db = await createTestDb();
  testDb.current = db;
  clearOrgContextCacheForTests();
  clearJwksClientsForTests();
  clearOidcDiscoveryForTests();
  resetSignInProviderProblemsForTests();
  mock = await createMockSignInProviders();
  access = await createMockAccess();
  vi.stubGlobal("fetch", mock.fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useEnv({});
});

describe("the sign-in page's methods", () => {
  it("offers nothing but passwords when no provider is set", async () => {
    const response = await api("/sign-in-methods");
    await expect(response.json()).resolves.toMatchObject({
      emailPassword: true,
      providers: [],
    });
  });

  it("lists each provider that is on, in catalog order, with its label", async () => {
    useEnv({
      ...MOCK_SIGN_IN_ENV.oidc,
      ...MOCK_SIGN_IN_ENV.github,
      ...MOCK_SIGN_IN_ENV.google,
    });
    const response = await api("/sign-in-methods");
    await expect(response.json()).resolves.toMatchObject({
      providers: [
        { id: "google", label: "Google" },
        { id: "github", label: "GitHub" },
        { id: "oidc", label: "Acme SSO" },
      ],
    });
  });

  it("leaves a half-set provider off instead of half-configuring it", async () => {
    useEnv({ GOOGLE_SIGNIN_CLIENT_ID: "only-the-id" });
    const response = await api("/sign-in-methods");
    await expect(response.json()).resolves.toMatchObject({ providers: [] });
    const refused = await start(new Browser(), "google");
    expect(refused.status).not.toBe(200);
  });

  it("lists Cloudflare Access first, then the providers", async () => {
    useEnv({ ...MOCK_ACCESS_ENV.oidc, ...MOCK_SIGN_IN_ENV.google });
    const response = await api("/sign-in-methods");
    await expect(response.json()).resolves.toMatchObject({
      providers: [
        { id: "cloudflare-access", label: "Company SSO" },
        { id: "google", label: "Google" },
      ],
    });
  });
});

describe("Continue with SSO (a generic OIDC issuer)", () => {
  beforeEach(() => {
    useEnv(MOCK_SIGN_IN_ENV.oidc);
  });

  it("signs an invited person in, accepting the invitation with its role and default apps", async () => {
    const owner = await claimGateway();
    const appRowId = await seedDefaultApp(owner.organizationId);
    const invitation = await inviteAs(owner, "jo@acme.com", "admin");
    const browser = new Browser();

    const response = await signIn(browser, "oidc", {
      email: "jo@acme.com",
      name: "Jo Acme",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");

    const user = await userByEmail("jo@acme.com");
    expect(user).toMatchObject({ name: "Jo Acme", emailVerified: true });
    expect(await membershipsOf("jo@acme.com")).toMatchObject([
      { organizationId: owner.organizationId, role: "admin" },
    ]);
    const [used] = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, invitation.invitationId));
    expect(used?.status).toBe("accepted");
    expect(await grantedAppsOf(user!.id)).toEqual([appRowId]);
    expect(await accountsOf("jo@acme.com", "oidc")).toHaveLength(1);
    await expect(sessionOf(browser)).resolves.toMatchObject({
      user: { email: "jo@acme.com" },
    });
    // Nothing was fetched when the gateway started: discovery on the
    // sign-in, the keys on the callback.
    expect(mock.calls.discovery).toBe(1);
    expect(mock.calls.jwks).toBe(1);
  });

  it("refuses a stranger and creates nothing for them", async () => {
    await claimGateway();
    const browser = new Browser();
    const response = await signIn(browser, "oidc", {
      email: "stranger@elsewhere.com",
    });
    expect(errorOf(response)).toBe("SIGNIN_NOT_INVITED");
    expect(await userByEmail("stranger@elsewhere.com")).toBeUndefined();
    await expect(sessionOf(browser)).resolves.toBeNull();
  });

  it("refuses an email the issuer hasn't verified, invited or not", async () => {
    const owner = await claimGateway();
    await inviteAs(owner, "jo@acme.com");
    const response = await signIn(new Browser(), "oidc", {
      email: "jo@acme.com",
      emailVerified: false,
    });
    expect(errorOf(response)).toBe("SIGNIN_EMAIL_NOT_VERIFIED");
    expect(await userByEmail("jo@acme.com")).toBeUndefined();
    expect(await membershipsOf("jo@acme.com")).toEqual([]);
  });

  it("signs nobody in before the gateway is claimed", async () => {
    const response = await signIn(new Browser(), "oidc", {
      email: "first@acme.com",
    });
    expect(errorOf(response)).toBe("SIGNIN_NOT_SET_UP");
    expect(await userByEmail("first@acme.com")).toBeUndefined();
  });

  it("signs an existing verified member in and links the identity by email", async () => {
    const owner = await claimGateway();
    const userId = await seedVerifiedMember(
      owner.organizationId,
      "pat@acme.com",
    );
    const browser = new Browser();
    const response = await signIn(browser, "oidc", { email: "pat@acme.com" });
    expect(response.headers.get("location")).toBe("/");
    expect(await accountsOf("pat@acme.com", "oidc")).toMatchObject([
      { userId },
    ]);
    await expect(sessionOf(browser)).resolves.toMatchObject({
      user: { id: userId },
    });
    // Still one membership: a member signs in, they don't join again.
    expect(await membershipsOf("pat@acme.com")).toHaveLength(1);
  });

  it("keys the account by the issuer's subject, so a changed email still finds it", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "pat@acme.com");
    const first = new Browser();
    await signIn(first, "oidc", { email: "pat@acme.com", sub: "sub-pat" });
    // The directory renamed Pat; the same subject still signs in as Pat.
    const second = new Browser();
    const response = await signIn(second, "oidc", {
      email: "patricia@acme.com",
      sub: "sub-pat",
    });
    expect(response.headers.get("location")).toBe("/");
    await expect(sessionOf(second)).resolves.toMatchObject({
      user: { email: "pat@acme.com" },
    });
    expect(await userByEmail("patricia@acme.com")).toBeUndefined();
  });

  it("won't hand an unverified password account to the same email, until its owner connects the provider while signed in", async () => {
    const owner = await claimGateway();
    const browser = new Browser();
    const refused = await signIn(browser, "oidc", { email: OWNER.email });
    expect(errorOf(refused)).toBe("account_not_linked");
    expect(await accountsOf(OWNER.email, "oidc")).toEqual([]);
    await expect(sessionOf(browser)).resolves.toBeNull();

    // Signed in with the password, the owner connects SSO themselves.
    await passwordSignIn(browser, OWNER.email, OWNER.password);
    const linkResponse = await api("/link-social", {
      method: "POST",
      browser,
      body: { provider: "oidc", callbackURL: "/" },
    });
    expect(linkResponse.status).toBe(200);
    const { url } = (await linkResponse.json()) as { url: string };
    const linked = await finish(browser, url, { email: OWNER.email });
    expect(linked.headers.get("location")).toBe("/");
    expect(await accountsOf(OWNER.email, "oidc")).toHaveLength(1);

    // Next time, SSO alone signs the owner in, and the sign-in verifies
    // the account's email (the provider vouched for the same address).
    const fresh = new Browser();
    const next = await signIn(fresh, "oidc", { email: OWNER.email });
    expect(next.headers.get("location")).toBe("/");
    await expect(sessionOf(fresh)).resolves.toMatchObject({
      user: { id: owner.userId },
    });
    expect((await userByEmail(OWNER.email))?.emailVerified).toBe(true);
  });

  it("won't connect an identity of another email to a signed-in account", async () => {
    await claimGateway();
    const browser = new Browser();
    await passwordSignIn(browser, OWNER.email, OWNER.password);
    const linkResponse = await api("/link-social", {
      method: "POST",
      browser,
      body: { provider: "oidc", callbackURL: "/" },
    });
    const { url } = (await linkResponse.json()) as { url: string };
    const refused = await finish(browser, url, { email: "someone@acme.com" });
    expect(errorOf(refused)).toBe("email_does_not_match");
    expect(await accountsOf(OWNER.email, "oidc")).toEqual([]);
  });

  it("won't connect an identity whose email the issuer hasn't verified", async () => {
    await claimGateway();
    const browser = new Browser();
    await passwordSignIn(browser, OWNER.email, OWNER.password);
    const linkResponse = await api("/link-social", {
      method: "POST",
      browser,
      body: { provider: "oidc", callbackURL: "/" },
    });
    const { url } = (await linkResponse.json()) as { url: string };
    const refused = await finish(browser, url, {
      email: OWNER.email,
      emailVerified: false,
    });
    expect(errorOf(refused)).toBe("unable_to_link_account");
    expect(await accountsOf(OWNER.email, "oidc")).toEqual([]);
  });

  it("refuses a deactivated member", async () => {
    const owner = await claimGateway();
    const userId = await seedVerifiedMember(
      owner.organizationId,
      "pat@acme.com",
    );
    await signIn(new Browser(), "oidc", { email: "pat@acme.com" });
    // Deactivated the way Admin → Users does it: Better Auth's ban fields.
    await db.update(users).set({ banned: true }).where(eq(users.id, userId));
    const browser = new Browser();
    const response = await signIn(browser, "oidc", { email: "pat@acme.com" });
    // Better Auth's admin plugin refuses the ban first (BANNED_USER); the
    // membership policy would answer SIGNIN_ACCOUNT_DEACTIVATED after it.
    // The sign-in page explains both the same way.
    expect(["BANNED_USER", "SIGNIN_ACCOUNT_DEACTIVATED"]).toContain(
      errorOf(response),
    );
    await expect(sessionOf(browser)).resolves.toBeNull();
  });

  it("takes the email from the userinfo endpoint when the ID token has none", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "pat@acme.com");
    const browser = new Browser();
    const response = await signIn(browser, "oidc", {
      email: "pat@acme.com",
      emailInUserInfoOnly: true,
    });
    expect(response.headers.get("location")).toBe("/");
    expect(mock.calls.userinfo).toBe(1);
    await expect(sessionOf(browser)).resolves.toMatchObject({
      user: { email: "pat@acme.com" },
    });
  });

  describe("the ID token", () => {
    it("must carry the nonce the sign-in started with", async () => {
      const owner = await claimGateway();
      await seedVerifiedMember(owner.organizationId, "pat@acme.com");
      const browser = new Browser();
      const response = await signIn(browser, "oidc", {
        email: "pat@acme.com",
        claims: { nonce: "another-request's" },
      });
      expect(errorOf(response)).toBe("unable_to_get_user_info");
      await expect(sessionOf(browser)).resolves.toBeNull();
    });

    it("must be for this client", async () => {
      const owner = await claimGateway();
      await seedVerifiedMember(owner.organizationId, "pat@acme.com");
      const response = await signIn(new Browser(), "oidc", {
        email: "pat@acme.com",
        claims: { aud: "another-client" },
      });
      expect(errorOf(response)).toBe("unable_to_get_user_info");
    });

    it("must be from the configured issuer", async () => {
      const owner = await claimGateway();
      await seedVerifiedMember(owner.organizationId, "pat@acme.com");
      const response = await signIn(new Browser(), "oidc", {
        email: "pat@acme.com",
        claims: { iss: "https://evil.example" },
      });
      expect(errorOf(response)).toBe("unable_to_get_user_info");
    });

    it("signs nobody in when the issuer's keys can't be fetched (fails closed)", async () => {
      const owner = await claimGateway();
      await seedVerifiedMember(owner.organizationId, "pat@acme.com");
      mock.state.jwksDown = true;
      const browser = new Browser();
      const response = await signIn(browser, "oidc", { email: "pat@acme.com" });
      expect(errorOf(response)).toBe("unable_to_get_user_info");
      await expect(sessionOf(browser)).resolves.toBeNull();
    });
  });

  describe("discovery", () => {
    it("refuses a document that names another issuer", async () => {
      await claimGateway();
      mock.state.discoveryIssuer = "https://other.example";
      const response = await start(new Browser(), "oidc");
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "SIGNIN_PROVIDER_UNAVAILABLE",
      });
    });

    it("answers clearly when the issuer is down, and tries again later", async () => {
      await claimGateway();
      mock.state.discoveryDown = true;
      const response = await start(new Browser(), "oidc");
      expect(response.status).toBe(503);
      mock.state.discoveryDown = false;
      const retry = await start(new Browser(), "oidc");
      expect(retry.status).toBe(200);
    });
  });

  it("doesn't sign in with a posted ID token", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "pat@acme.com");
    const response = await start(new Browser(), "oidc", {
      idToken: { token: "header.payload.signature" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await accountsOf("pat@acme.com", "oidc")).toEqual([]);
  });

  it("asks the issuer for identity scopes only", async () => {
    await claimGateway();
    const url = await authorizationUrl(new Browser(), "oidc");
    const { scopes } = mock.authorize(url, { email: "x@acme.com" });
    expect(scopes.sort()).toEqual(["email", "openid", "profile"]);
  });
});

describe("Continue with Google (Better Auth's provider against mocked endpoints)", () => {
  beforeEach(() => {
    useEnv(MOCK_SIGN_IN_ENV.google);
  });

  it("signs an invited person in, keyed by Google's subject", async () => {
    const owner = await claimGateway();
    await inviteAs(owner, "jo@acme.com");
    const browser = new Browser();
    const response = await signIn(browser, "google", {
      email: "jo@acme.com",
      sub: "118000000000000000001",
    });
    expect(response.headers.get("location")).toBe("/");
    expect(await accountsOf("jo@acme.com", "google")).toMatchObject([
      { accountId: "118000000000000000001" },
    ]);
    expect(await membershipsOf("jo@acme.com")).toHaveLength(1);
  });

  it("refuses an email Google hasn't verified", async () => {
    const owner = await claimGateway();
    await inviteAs(owner, "jo@acme.com");
    const response = await signIn(new Browser(), "google", {
      email: "jo@acme.com",
      emailVerified: false,
    });
    expect(errorOf(response)).toBe("SIGNIN_EMAIL_NOT_VERIFIED");
    expect(await userByEmail("jo@acme.com")).toBeUndefined();
  });

  it("refuses a stranger", async () => {
    await claimGateway();
    const response = await signIn(new Browser(), "google", {
      email: "stranger@gmail.com",
    });
    expect(errorOf(response)).toBe("SIGNIN_NOT_INVITED");
  });

  it("asks Google for identity scopes only", async () => {
    await claimGateway();
    const url = await authorizationUrl(new Browser(), "google");
    const { scopes } = mock.authorize(url, { email: "x@acme.com" });
    expect(scopes.sort()).toEqual(["email", "openid", "profile"]);
  });
});

describe("Continue with GitHub (Better Auth's provider against mocked endpoints)", () => {
  beforeEach(() => {
    useEnv(MOCK_SIGN_IN_ENV.github);
  });

  it("signs an invited person in by their primary verified email", async () => {
    const owner = await claimGateway();
    await inviteAs(owner, "jo@acme.com");
    const browser = new Browser();
    const response = await signIn(browser, "github", {
      email: "jo@acme.com",
      name: "Jo Acme",
      sub: "4242",
    });
    expect(response.headers.get("location")).toBe("/");
    expect(await accountsOf("jo@acme.com", "github")).toMatchObject([
      { accountId: "4242" },
    ]);
    await expect(sessionOf(browser)).resolves.toMatchObject({
      user: { email: "jo@acme.com" },
    });
  });

  it("refuses an email GitHub hasn't verified", async () => {
    const owner = await claimGateway();
    await inviteAs(owner, "jo@acme.com");
    const response = await signIn(new Browser(), "github", {
      email: "jo@acme.com",
      emailVerified: false,
    });
    expect(errorOf(response)).toBe("SIGNIN_EMAIL_NOT_VERIFIED");
    expect(await userByEmail("jo@acme.com")).toBeUndefined();
  });
});

describe("Continue with Cloudflare (a private OAuth client, Better Auth's provider against mocked endpoints)", () => {
  beforeEach(() => {
    useEnv(MOCK_SIGN_IN_ENV.cloudflare);
  });

  it("signs an invited account member in by the address Cloudflare knows them by", async () => {
    const owner = await claimGateway();
    await inviteAs(owner, "jo@acme.com");
    const browser = new Browser();
    const response = await signIn(browser, "cloudflare", {
      email: "jo@acme.com",
      name: "Jo Acme",
      sub: "7c5dae5552338874e5053f2534d2767a",
    });
    expect(response.headers.get("location")).toBe("/");
    expect(await accountsOf("jo@acme.com", "cloudflare")).toMatchObject([
      { accountId: "7c5dae5552338874e5053f2534d2767a" },
    ]);
    expect((await userByEmail("jo@acme.com"))?.emailVerified).toBe(true);
  });

  it("refuses a stranger", async () => {
    await claimGateway();
    const response = await signIn(new Browser(), "cloudflare", {
      email: "stranger@example.com",
    });
    expect(errorOf(response)).toBe("SIGNIN_NOT_INVITED");
  });

  it("asks Cloudflare for the user-details scope only", async () => {
    await claimGateway();
    const url = await authorizationUrl(new Browser(), "cloudflare");
    const { scopes } = mock.authorize(url, { email: "x@acme.com" });
    expect(scopes).toEqual(["user-details.read"]);
  });
});

describe("Continue with Apple's return", () => {
  it("answers Apple's cross-site POST with nothing but a redirect to the same URL as a GET", async () => {
    // Sign in with Apple returns with response_mode=form_post. The POST
    // reads no cookie and creates nothing: Better Auth sends the browser
    // to the same callback as a GET, with the code and state, and that
    // GET is checked like any other navigation (behind Access's login).
    useEnv({
      APPLE_SIGNIN_CLIENT_ID: "com.acme.gateway",
      APPLE_SIGNIN_CLIENT_SECRET: "eyJ.apple.secret",
    });
    await claimGateway();
    const response = await createAuth().handler(
      new Request(`${GATEWAY_URL}/api/auth/callback/apple`, {
        method: "POST",
        headers: {
          origin: "https://appleid.apple.com",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "code=apple-code&state=apple-state",
      }),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      `${GATEWAY_URL}/api/auth/callback/apple`,
    );
    expect(location.searchParams.get("code")).toBe("apple-code");
    expect(location.searchParams.get("state")).toBe("apple-state");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
  });
});

describe("turning password sign-in off with a sign-in provider", () => {
  it("takes effect only once an owner has connected the provider", async () => {
    useEnv({ ...MOCK_SIGN_IN_ENV.oidc, EMAIL_PASSWORD_SIGN_IN: "false" });
    await claimGateway();
    // No owner can sign in without a password yet: passwords stay on.
    await expect((await api("/sign-in-methods")).json()).resolves.toMatchObject(
      { emailPassword: true },
    );
    const browser = new Browser();
    expect(
      (await passwordSignIn(browser, OWNER.email, OWNER.password)).status,
    ).toBe(200);

    const linkResponse = await api("/link-social", {
      method: "POST",
      browser,
      body: { provider: "oidc", callbackURL: "/" },
    });
    const { url } = (await linkResponse.json()) as { url: string };
    await finish(browser, url, { email: OWNER.email });

    await expect((await api("/sign-in-methods")).json()).resolves.toMatchObject(
      { emailPassword: false },
    );
    const refused = await passwordSignIn(
      new Browser(),
      OWNER.email,
      OWNER.password,
    );
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      code: "PASSWORD_SIGN_IN_DISABLED",
    });
  });

  it("is ignored while no provider and no Access sign-in is configured", async () => {
    useEnv({ EMAIL_PASSWORD_SIGN_IN: "false" });
    await claimGateway();
    await expect((await api("/sign-in-methods")).json()).resolves.toMatchObject(
      { emailPassword: true },
    );
  });
});

describe("on the hosted gateway (open sign-up)", () => {
  beforeEach(() => {
    useEnv({
      ...MOCK_SIGN_IN_ENV.oidc,
      GATEWAY_DEPLOYMENT_MODE: "hosted",
    });
  });

  it("lets a verified stranger make an account with a personal organization", async () => {
    await claimGateway();
    const browser = new Browser();
    const response = await signIn(browser, "oidc", {
      email: "new@example.com",
      name: "New Person",
    });
    expect(response.headers.get("location")).toBe("/");
    const user = await userByEmail("new@example.com");
    expect(user?.emailVerified).toBe(true);
    const memberships = await membershipsOf("new@example.com");
    expect(memberships).toMatchObject([{ role: "owner" }]);
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, memberships[0]!.organizationId));
    expect(organization?.name).toContain("New Person");
  });

  it("still refuses an email the issuer hasn't verified", async () => {
    await claimGateway();
    const response = await signIn(new Browser(), "oidc", {
      email: "new@example.com",
      emailVerified: false,
    });
    expect(errorOf(response)).toBe("SIGNIN_EMAIL_NOT_VERIFIED");
    expect(await userByEmail("new@example.com")).toBeUndefined();
  });

  it("still signs nobody in before the gateway is claimed", async () => {
    const response = await signIn(new Browser(), "oidc", {
      email: "new@example.com",
    });
    expect(errorOf(response)).toBe("SIGNIN_NOT_SET_UP");
  });
});

describe("behind Cloudflare Access's outer ring", () => {
  beforeEach(() => {
    useEnv({ ...MOCK_SIGN_IN_ENV.oidc, ...MOCK_ACCESS_ENV.outerRing });
    // Both mocks answer: Access's keys and the issuer's endpoints.
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await access.fetch(input, init);
        return response.status === 404 ? mock.fetch(input, init) : response;
      },
    );
  });

  it("signs in only the person Access vouches for on the request", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "pat@acme.com");
    await seedVerifiedMember(owner.organizationId, "sam@acme.com");
    const headers = {
      "cf-access-jwt-assertion": await access.assertion({
        email: "pat@acme.com",
      }),
    };
    const other = new Browser();
    const refused = await signIn(
      other,
      "oidc",
      { email: "sam@acme.com" },
      headers,
    );
    expect(errorOf(refused)).toBe("ACCESS_EMAIL_MISMATCH");

    const browser = new Browser();
    const response = await signIn(
      browser,
      "oidc",
      { email: "pat@acme.com" },
      headers,
    );
    expect(response.headers.get("location")).toBe("/");
  });

  it("makes no session for a sign-in that didn't come through Access", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "pat@acme.com");
    const browser = new Browser();
    const response = await signIn(browser, "oidc", { email: "pat@acme.com" });
    expect(errorOf(response)).toBe("ACCESS_REQUIRED");
  });
});
