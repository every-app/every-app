/**
 * Signing in with Cloudflare Access, end to end through the real Better Auth
 * configuration (createAuth) on a migrated SQLite database, against a mock
 * Access (src/test/mock-access.ts): the outer ring's session exchange, OIDC
 * sign-in through Better Auth's own state and PKCE, who gets in (members,
 * invitations, auto-join, strangers, deactivated users, an unclaimed
 * gateway), account linking, the mobile shell's flow and turning password
 * sign-in off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const workerEnv = vi.hoisted(
  () =>
    ({
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
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { createAuth } from "@/auth";
import {
  accounts,
  apps,
  invitations,
  members,
  ownerSetupTokens,
  sessions,
  userAppAccess,
  users,
  verifications,
} from "@/db/schema";
import { UserRepository } from "@/server/repositories/UserRepository";
import { AdminService } from "@/server/services/AdminService";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { InvitationService } from "@/server/services/InvitationService";
import { MembershipService } from "@/server/services/MembershipService";
import { SetupService } from "@/server/services/SetupService";
import {
  APPS_AUD,
  createMockAccess,
  MOCK_ACCESS_ENV,
  OIDC_CLIENT_ID,
  type MockAccess,
  type MockIdentity,
} from "@/test/mock-access";
import { createTestDb } from "@/test/sqlite-db";
import { readAccessConfig } from "./config";
import { clearJwksClientsForTests } from "./jwt";
import { accessSignInMode, ensureAccessMembership } from "./membership";

const GATEWAY_URL = "https://gateway.example.com";
const BASE_ENV = { ...workerEnv };
const OWNER = {
  name: "Owner",
  email: "owner@acme.com",
  password: "owner-password-1",
};

/** Replace the Access settings (Worker secrets) for this test. */
function useAccessEnv(settings: Record<string, string>) {
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

  has(name: string): boolean {
    return this.cookies.has(name);
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

/** A top-level navigation: a GET with no Origin, as browsers send it. */
async function navigate(
  url: string,
  browser: Browser,
  headers: Record<string, string> = {},
): Promise<Response> {
  const cookie = browser.header();
  const response = await createAuth().handler(
    new Request(url, {
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    }),
  );
  browser.store(response);
  return response;
}

let db: TestDb;
let access: MockAccess;

async function userByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user;
}

async function membershipOf(email: string) {
  const user = await userByEmail(email);
  if (!user) return undefined;
  const [membership] = await db
    .select()
    .from(members)
    .where(eq(members.userId, user.id));
  return membership;
}

async function accessAccountsOf(email: string) {
  const user = await userByEmail(email);
  if (!user) return [];
  return db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, user.id),
        eq(accounts.providerId, "cloudflare-access"),
      ),
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

/** The header Access adds to a request from `email`'s browser. */
async function throughAccess(email: string): Promise<Record<string, string>> {
  return { "cf-access-jwt-assertion": await access.assertion({ email }) };
}

/** A member whose email is verified (say, joined through Access earlier). */
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

/** The app rows a user has been granted. */
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
  // The owner signs in with a password to invite (through Access when the
  // outer ring is on).
  expect(
    (
      await passwordSignIn(
        ownerBrowser,
        OWNER.email,
        OWNER.password,
        await throughAccess(OWNER.email),
      )
    ).status,
  ).toBe(200);
  return InvitationService.invite(
    { orgId: owner.organizationId, userId: owner.userId, role: "owner" },
    new Headers({ cookie: ownerBrowser.header() }),
    { email, role },
  );
}

beforeEach(async () => {
  db = await createTestDb();
  testDb.current = db;
  clearOrgContextCacheForTests();
  clearJwksClientsForTests();
  access = await createMockAccess();
  vi.stubGlobal("fetch", access.fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAccessEnv({});
});

describe("outer ring: Access in front of the gateway (SQLite)", () => {
  beforeEach(() => {
    useAccessEnv(MOCK_ACCESS_ENV.outerRing);
  });

  /** The browser's session check, through the outer ring as `identity`. */
  async function getSession(
    browser: Browser,
    identity: MockIdentity | null,
    options: { host?: string; assertion?: string } = {},
  ) {
    const assertion =
      options.assertion ?? (identity ? await access.assertion(identity) : "");
    return send(
      `https://${options.host ?? "gateway.example.com"}/api/auth/get-session`,
      {
        browser,
        headers: assertion ? { "cf-access-jwt-assertion": assertion } : {},
      },
    );
  }

  it("signs an existing member in with no second login, and links the identity", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");

    const browser = new Browser();
    const response = await getSession(browser, { email: "Alice@Acme.com" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      user: { email: "alice@acme.com" },
      session: { activeOrganizationId: owner.organizationId },
    });
    expect(browser.has("better-auth.session_token")).toBe(true);
    expect(await accessAccountsOf("alice@acme.com")).toEqual([
      expect.objectContaining({ accountId: "alice@acme.com" }),
    ]);

    // The browser now holds a normal Better Auth session, used as it is on
    // every request Access vouches for (no new one each time).
    const again = await getSession(browser, { email: "alice@acme.com" });
    await expect(again.json()).resolves.toMatchObject({
      user: { email: "alice@acme.com" },
    });
    const alice = await userByEmail("alice@acme.com");
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, alice!.id)),
    ).toHaveLength(1);
  });

  it("asks an account whose email isn't verified to sign in once with its password, then links it", async () => {
    const owner = await claimGateway();
    // The owner's account came from the setup link: a password, an email
    // nobody verified. Access saying "owner@acme.com" isn't enough to hand
    // the account over.
    const first = new Browser();
    const refused = await getSession(first, { email: OWNER.email });
    await expect(refused.json()).resolves.toBeNull();
    expect(first.has("better-auth.session_token")).toBe(false);
    expect(await accessAccountsOf(OWNER.email)).toEqual([]);

    // Signed in with the password, through the outer ring as the same email:
    // they hold both, so the identity is linked and the email verified.
    expect(
      (
        await passwordSignIn(
          first,
          OWNER.email,
          OWNER.password,
          await throughAccess(OWNER.email),
        )
      ).status,
    ).toBe(200);
    const linked = await getSession(first, { email: OWNER.email });
    await expect(linked.json()).resolves.toMatchObject({
      user: { id: owner.userId },
    });
    expect(await accessAccountsOf(OWNER.email)).toHaveLength(1);
    expect((await userByEmail(OWNER.email))?.emailVerified).toBe(true);

    // From then on the outer ring signs them in by itself.
    const fresh = new Browser();
    const auto = await getSession(fresh, { email: OWNER.email });
    await expect(auto.json()).resolves.toMatchObject({
      user: { id: owner.userId },
    });
    expect(fresh.has("better-auth.session_token")).toBe(true);
  });

  it("makes an invited person a member, with the invited role and the default apps", async () => {
    const owner = await claimGateway();
    const appId = await seedDefaultApp(owner.organizationId);
    await inviteAs(owner, "bob@partner.example", "admin");

    const browser = new Browser();
    const response = await getSession(browser, {
      email: "bob@partner.example",
    });
    const body = (await response.json()) as { user: { id: string } };
    expect(body).toMatchObject({
      // The outer ring's assertion carries no name: the email's local part.
      user: { email: "bob@partner.example", name: "bob", emailVerified: true },
      session: { activeOrganizationId: owner.organizationId },
    });

    expect(await membershipOf("bob@partner.example")).toMatchObject({
      organizationId: owner.organizationId,
      role: "admin",
    });
    const [invitation] = await db.select().from(invitations);
    expect(invitation?.status).toBe("accepted");
    expect(await grantedAppsOf(body.user.id)).toEqual([appId]);
  });

  it("lets the invite link confirm an invitation Access already accepted, for that person only", async () => {
    const owner = await claimGateway();
    const { inviteUrl } = await inviteAs(owner, "bob@partner.example");
    const token = new URL(inviteUrl).searchParams.get("token")!;

    const response = await getSession(new Browser(), {
      email: "bob@partner.example",
    });
    const { user } = (await response.json()) as {
      user: { id: string; email: string };
    };
    // Bob opens the link afterwards: the accept page just confirms it.
    await expect(
      InvitationService.accept(user, new Headers(), token),
    ).resolves.toEqual({ organizationId: owner.organizationId });

    // Anyone else holding the link gets nothing from it.
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    await expect(
      InvitationService.accept(
        { id: "user-alice@acme.com", email: "alice@acme.com" },
        new Headers(),
        token,
      ),
    ).rejects.toMatchObject({ code: "INVITATION_TOKEN_INVALID" });
  });

  it("lets people from an auto-join domain in as members, with the apps available to everyone", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.outerRing,
      CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: "acme.com",
    });
    const owner = await claimGateway();
    const appId = await seedDefaultApp(owner.organizationId);

    const response = await getSession(new Browser(), {
      email: "carol@acme.com",
    });
    const body = (await response.json()) as { user: { id: string } };
    expect(body).toMatchObject({ user: { email: "carol@acme.com" } });
    expect(await membershipOf("carol@acme.com")).toMatchObject({
      organizationId: owner.organizationId,
      role: "member",
    });
    // The same default apps an accepted invitation gives, and only those.
    expect(await grantedAppsOf(body.user.id)).toEqual([appId]);

    // Another domain (even one ending in it) is a stranger.
    for (const email of ["dave@other.example", "eve@notacme.com"]) {
      const refused = await getSession(new Browser(), { email });
      await expect(refused.json()).resolves.toBeNull();
      expect(await userByEmail(email)).toBeUndefined();
    }
  });

  it("deactivates instead of deleting someone Access would let straight back in", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.outerRing,
      CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: "acme.com",
    });
    const owner = await claimGateway();
    const ownerCtx = {
      orgId: owner.organizationId,
      userId: owner.userId,
      role: "owner" as const,
    };
    const carolsBrowser = new Browser();
    const joined = (await (
      await getSession(carolsBrowser, { email: "carol@acme.com" })
    ).json()) as { user: { id: string } };

    // Admin → Users → Delete: deleting the account would only let her
    // join again at her next Access sign-in, so she is deactivated.
    await expect(
      AdminService.deleteUser(ownerCtx, joined.user.id),
    ).resolves.toEqual({ deactivatedInstead: true });
    const carol = await userByEmail("carol@acme.com");
    expect(carol).toMatchObject({ id: joined.user.id, banned: true });
    expect(await membershipOf("carol@acme.com")).toBeDefined();
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, carol!.id)),
    ).toEqual([]);

    // She stays out, through Access or not.
    const again = await getSession(new Browser(), { email: "carol@acme.com" });
    await expect(again.json()).resolves.toBeNull();
    expect(
      await db.select().from(users).where(eq(users.email, "carol@acme.com")),
    ).toHaveLength(1);

    // Someone Access wouldn't let back in by themselves is deleted as before.
    const { inviteUrl } = await inviteAs(owner, "dave@partner.example");
    expect(inviteUrl).toBeTruthy();
    const dave = (await (
      await getSession(new Browser(), { email: "dave@partner.example" })
    ).json()) as { user: { id: string } };
    await expect(
      AdminService.deleteUser(ownerCtx, dave.user.id),
    ).resolves.toEqual({ deactivatedInstead: false });
    expect(await userByEmail("dave@partner.example")).toBeUndefined();
    const daveAgain = await getSession(new Browser(), {
      email: "dave@partner.example",
    });
    await expect(daveAgain.json()).resolves.toBeNull();
  });

  it("lets everyone the outer ring admits join when the operator says so", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.outerRing,
      CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN: "everyone",
    });
    const owner = await claimGateway();
    const appId = await seedDefaultApp(owner.organizationId);
    const response = await getSession(new Browser(), {
      email: "frank@anywhere.example",
    });
    const body = (await response.json()) as { user: { id: string } };
    expect(body).toMatchObject({ user: { email: "frank@anywhere.example" } });
    expect(await membershipOf("frank@anywhere.example")).toMatchObject({
      organizationId: owner.organizationId,
      role: "member",
    });
    expect(await grantedAppsOf(body.user.id)).toEqual([appId]);
  });

  it("keeps one account per Access identity when first sign-ins race", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.outerRing,
      CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: "acme.com",
    });
    const owner = await claimGateway();
    // Several restored tabs, all through the outer ring at once.
    const tabs = [new Browser(), new Browser(), new Browser()];
    const sessions = await Promise.all(
      tabs.map(async (tab) =>
        (await getSession(tab, { email: "erin@acme.com" })).json(),
      ),
    );
    expect(sessions.some((session) => session !== null)).toBe(true);
    expect(await accessAccountsOf("erin@acme.com")).toHaveLength(1);
    expect(
      await db
        .select()
        .from(members)
        .where(eq(members.organizationId, owner.organizationId)),
    ).toHaveLength(2);

    // And the identity still signs in afterwards.
    const later = await getSession(new Browser(), { email: "erin@acme.com" });
    await expect(later.json()).resolves.toMatchObject({
      user: { email: "erin@acme.com" },
    });
  });

  it("can't store a second account for the same identity", async () => {
    const owner = await claimGateway();
    const account = {
      providerId: "cloudflare-access",
      accountId: "alice@acme.com",
      userId: owner.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(accounts).values({ id: "account-1", ...account });
    // What a racing link would try: Better Auth then refuses that sign-in
    // instead of keeping two rows it could never tell apart.
    await expect(
      db.insert(accounts).values({ id: "account-2", ...account }),
    ).rejects.toThrow();
  });

  it("refuses a stranger and creates nothing", async () => {
    await claimGateway();
    const browser = new Browser();
    const response = await getSession(browser, {
      email: "mallory@evil.example",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
    expect(browser.has("better-auth.session_token")).toBe(false);
    expect(await userByEmail("mallory@evil.example")).toBeUndefined();
  });

  it("keeps a deactivated member out", async () => {
    const owner = await claimGateway();
    const userId = await seedVerifiedMember(
      owner.organizationId,
      "gone@acme.com",
    );
    await UserRepository.deactivate(userId, "test");

    const browser = new Browser();
    const response = await getSession(browser, { email: "gone@acme.com" });
    await expect(response.json()).resolves.toBeNull();
    expect(browser.has("better-auth.session_token")).toBe(false);
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, userId)),
    ).toEqual([]);
  });

  it("creates no account on a gateway nobody has claimed, whatever the settings", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.outerRing,
      CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: "acme.com",
      CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN: "everyone",
    });
    const response = await getSession(new Browser(), {
      email: "first@acme.com",
    });
    await expect(response.json()).resolves.toBeNull();
    expect(await db.select().from(users)).toEqual([]);
  });

  it("swaps a session that belongs to someone else for the Access user's own", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");

    // The owner signed in with a password in this browser; now Access says
    // Alice is the one here.
    const browser = new Browser();
    await passwordSignIn(
      browser,
      OWNER.email,
      OWNER.password,
      await throughAccess(OWNER.email),
    );
    const response = await getSession(browser, { email: "alice@acme.com" });
    await expect(response.json()).resolves.toMatchObject({
      user: { email: "alice@acme.com" },
    });
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId)),
    ).toEqual([]);
    const again = await getSession(browser, { email: "alice@acme.com" });
    await expect(again.json()).resolves.toMatchObject({
      user: { email: "alice@acme.com" },
    });
  });

  it("signs the Access user in again when their own session has expired", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    const browser = new Browser();
    await getSession(browser, { email: "alice@acme.com" });
    const [alice] = await db
      .select()
      .from(users)
      .where(eq(users.email, "alice@acme.com"));
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, alice!.id));

    const response = await getSession(browser, { email: "alice@acme.com" });
    await expect(response.json()).resolves.toMatchObject({
      user: { id: alice!.id },
    });
    expect(browser.has("better-auth.session_token")).toBe(true);
  });

  it("ends someone else's session even when the Access user may not sign in", async () => {
    const owner = await claimGateway();
    const browser = new Browser();
    await passwordSignIn(
      browser,
      OWNER.email,
      OWNER.password,
      await throughAccess(OWNER.email),
    );

    const response = await getSession(browser, {
      email: "mallory@evil.example",
    });
    await expect(response.json()).resolves.toBeNull();
    expect(browser.has("better-auth.session_token")).toBe(false);
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId)),
    ).toEqual([]);
  });

  it("signs nobody in with an assertion it can't verify, and honours no session with one", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    const browser = new Browser();
    await passwordSignIn(
      browser,
      OWNER.email,
      OWNER.password,
      await throughAccess(OWNER.email),
    );

    const forged = await access.assertion({
      email: "alice@acme.com",
      claims: { aud: ["another-application"] },
    });
    for (const assertion of [forged, "not-a-jwt"]) {
      const response = await getSession(browser, null, { assertion });
      // Nobody is signed in as Alice, and the owner's session doesn't
      // count without Access's word for it either.
      await expect(response.json()).resolves.toBeNull();
    }
    expect(await accessAccountsOf("alice@acme.com")).toEqual([]);
    // It isn't ended, though: proof of someone else it wasn't.
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId)),
    ).toHaveLength(1);
    await expect(
      (await getSession(browser, { email: OWNER.email })).json(),
    ).resolves.toMatchObject({ user: { id: owner.userId } });
  });

  it("counts a session only with Access's word for that person, wherever it is looked up", async () => {
    const owner = await claimGateway();
    const browser = new Browser();
    await passwordSignIn(
      browser,
      OWNER.email,
      OWNER.password,
      await throughAccess(OWNER.email),
    );
    const ownerAssertion = await access.assertion({ email: OWNER.email });
    const cookie = browser.header();
    const auth = createAuth();

    // Server-side lookups (the perimeter, server functions, the OAuth
    // pages): the header Access adds, or its CF_Authorization cookie, which
    // browsers also send on paths Access lets through without a login.
    const vouched: Record<string, string>[] = [
      { cookie, "cf-access-jwt-assertion": ownerAssertion },
      { cookie: `${cookie}; CF_Authorization=${ownerAssertion}` },
    ];
    for (const headers of vouched) {
      await expect(
        auth.api.getSession({ headers: new Headers(headers) }),
      ).resolves.toMatchObject({ user: { id: owner.userId } });
    }
    // Without it (someone the Access policy no longer lets in, whose Access
    // session has run out, calling a bypassed path with the cookie): none.
    await expect(
      auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).resolves.toBeNull();

    // The browser's own check, on the gateway's host or any other.
    for (const host of [
      "gateway.example.com",
      "every-app-gateway.acme.workers.dev",
    ]) {
      const response = await getSession(browser, null, { host });
      await expect(response.json()).resolves.toBeNull();
    }
    // Not deleted, just not honoured: the browser keeps it for when Access
    // vouches for it again.
    expect(browser.has("better-auth.session_token")).toBe(true);
    await expect(
      (await getSession(browser, { email: OWNER.email })).json(),
    ).resolves.toMatchObject({ user: { id: owner.userId } });
  });

  it("won't sign an account in whose email isn't the one Access asserts, and says so", async () => {
    // The owner claimed the gateway as owner@acme.com, but Access knows them
    // as ben@company.example.
    const owner = await claimGateway();
    const browser = new Browser();
    const refused = await passwordSignIn(
      browser,
      OWNER.email,
      OWNER.password,
      await throughAccess("ben@company.example"),
    );
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      code: "ACCESS_EMAIL_MISMATCH",
    });
    // No session to be swapped away on the next request.
    expect(browser.has("better-auth.session_token")).toBe(false);
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId)),
    ).toEqual([]);

    // The documented way out: the account's email changed to the address
    // Access asserts, then one password sign-in through Access connects it.
    await db
      .update(users)
      .set({ email: "ben@company.example" })
      .where(eq(users.id, owner.userId));
    expect(
      (
        await passwordSignIn(
          browser,
          "ben@company.example",
          OWNER.password,
          await throughAccess("ben@company.example"),
        )
      ).status,
    ).toBe(200);
    await expect(
      (await getSession(browser, { email: "ben@company.example" })).json(),
    ).resolves.toMatchObject({ user: { id: owner.userId } });
    expect(await accessAccountsOf("ben@company.example")).toHaveLength(1);
  });

  it("makes no session for a request that didn't come through Access", async () => {
    const owner = await claimGateway();
    const response = await passwordSignIn(
      new Browser(),
      OWNER.email,
      OWNER.password,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "ACCESS_REQUIRED",
    });
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId)),
    ).toEqual([]);
  });

  it("lets Better Auth's own endpoints use only a session Access vouches for", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    const browser = new Browser();
    await passwordSignIn(
      browser,
      OWNER.email,
      OWNER.password,
      await throughAccess(OWNER.email),
    );
    const alice = await access.assertion({ email: "alice@acme.com" });

    // Access says Alice is at this browser now (or says nothing): the
    // owner's session is out of these requests, as if there were none.
    for (const headers of [
      { "cf-access-jwt-assertion": alice },
      {} as Record<string, string>,
    ]) {
      const accounts = await api("/list-accounts", { browser, headers });
      expect(accounts.status).toBe(401);
      const renamed = await api("/update-user", {
        method: "POST",
        browser,
        body: { name: "renamed by whoever holds the browser" },
        headers,
      });
      expect(renamed.status).toBe(401);
    }
    expect((await userByEmail(OWNER.email))?.name).toBe(OWNER.name);

    // With Access's word for the owner, they work as before.
    const owners = await api("/list-accounts", {
      browser,
      headers: {
        "cf-access-jwt-assertion": await access.assertion({
          email: OWNER.email,
        }),
      },
    });
    expect(owners.status).toBe(200);
    await expect(owners.json()).resolves.toEqual([
      expect.objectContaining({ providerId: "credential" }),
    ]);

    // Signing out always works.
    const signedOut = await api("/sign-out", {
      method: "POST",
      browser,
      body: {},
      headers: { "cf-access-jwt-assertion": alice },
    });
    expect(signedOut.status).toBe(200);
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId)),
    ).toEqual([]);
  });

  it("signs people in only with an assertion for the gateway's own Access application", async () => {
    // A separate Access application on the apps' hosts: an app host's
    // Access token never signs anyone in at the gateway.
    useAccessEnv({
      ...MOCK_ACCESS_ENV.outerRing,
      CLOUDFLARE_ACCESS_APPS_AUD: APPS_AUD,
    });
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");

    for (const claims of [
      { aud: [APPS_AUD] },
      // Access's organization token (the team domain's own session), not
      // an application's.
      { type: "org" },
    ]) {
      const browser = new Browser();
      const refused = await getSession(browser, {
        email: "alice@acme.com",
        claims,
      });
      await expect(refused.json()).resolves.toBeNull();
      expect(browser.has("better-auth.session_token")).toBe(false);
      const methods = await api("/sign-in-methods", {
        headers: {
          "cf-access-jwt-assertion": await access.assertion({
            email: "alice@acme.com",
            claims,
          }),
        },
      });
      await expect(methods.json()).resolves.toMatchObject({
        accessEmail: null,
      });
    }
    expect(await accessAccountsOf("alice@acme.com")).toEqual([]);

    const signedIn = await getSession(new Browser(), {
      email: "alice@acme.com",
    });
    await expect(signedIn.json()).resolves.toMatchObject({
      user: { email: "alice@acme.com" },
    });
  });

  it("signs nobody in when Access's keys can't be fetched (fails closed)", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    access.state.jwksDown = true;
    const response = await getSession(new Browser(), {
      email: "alice@acme.com",
    });
    await expect(response.json()).resolves.toBeNull();
  });

  it("only acts on the gateway's own host", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    for (const host of [
      "todo.gateway.example.com",
      "every-app-gateway.acme.workers.dev",
    ]) {
      const response = await getSession(
        new Browser(),
        { email: "alice@acme.com" },
        { host },
      );
      await expect(response.json()).resolves.toBeNull();
    }
  });

  it("tells the sign-in page who Access says is here, only from a verified assertion", async () => {
    await claimGateway();
    const verified = await api("/sign-in-methods", {
      headers: {
        "cf-access-jwt-assertion": await access.assertion({
          email: "Alice@Acme.com",
        }),
      },
    });
    expect(verified.headers.get("cache-control")).toBe("no-store");
    await expect(verified.json()).resolves.toEqual({
      emailPassword: true,
      providers: [],
      accessEmail: "alice@acme.com",
    });

    const unverified = await api("/sign-in-methods", {
      headers: { "cf-access-jwt-assertion": "not-a-jwt" },
    });
    await expect(unverified.json()).resolves.toMatchObject({
      accessEmail: null,
    });
  });
});

describe("OIDC sign-in: Continue with Company SSO (SQLite)", () => {
  beforeEach(() => {
    useAccessEnv(MOCK_ACCESS_ENV.oidc);
  });

  /** Click "Continue with Company SSO": Better Auth's authorization URL. */
  async function start(
    browser: Browser,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<string> {
    const response = await api("/sign-in/social", {
      method: "POST",
      browser,
      body: {
        provider: "cloudflare-access",
        callbackURL: "/",
        errorCallbackURL: "/sign-in",
        ...body,
      },
      headers,
    });
    expect(response.status).toBe(200);
    const { url, redirect } = (await response.json()) as {
      url: string;
      redirect: boolean;
    };
    expect(redirect).toBe(true);
    return url;
  }

  /** Log in at Access as `identity` and follow the redirect back. */
  function finish(
    browser: Browser,
    authorizationUrl: string,
    identity: MockIdentity,
  ): Promise<Response> {
    return send(access.authorize(authorizationUrl, identity).toString(), {
      browser,
    });
  }

  function errorOf(response: Response): string | null {
    const location = response.headers.get("location");
    if (!location) return null;
    return new URL(location, GATEWAY_URL).searchParams.get("error");
  }

  it("lists the provider with its label on the sign-in page", async () => {
    const response = await api("/sign-in-methods");
    await expect(response.json()).resolves.toEqual({
      emailPassword: true,
      providers: [{ id: "cloudflare-access", label: "Company SSO" }],
      accessEmail: null,
    });
  });

  it("sends the browser to Access with state and PKCE (S256), and signs an invited person in", async () => {
    const owner = await claimGateway();
    await inviteAs(owner, "bob@partner.example");

    const browser = new Browser();
    const authorizationUrl = await start(browser);
    const url = new URL(authorizationUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: OIDC_CLIENT_ID,
      redirect_uri: `${GATEWAY_URL}/api/auth/callback/cloudflare-access`,
      scope: "openid email profile",
      code_challenge_method: "S256",
      state: expect.any(String),
      code_challenge: expect.any(String),
    });
    // Better Auth binds the state to this browser.
    expect(browser.has("better-auth.state")).toBe(true);

    const callback = await finish(browser, authorizationUrl, {
      email: "Bob@Partner.example",
      name: "Bob",
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    expect(access.calls.token).toBe(1);

    const session = await api("/get-session", { browser });
    await expect(session.json()).resolves.toMatchObject({
      user: { email: "bob@partner.example", emailVerified: true },
      session: { activeOrganizationId: owner.organizationId },
    });
    expect(await membershipOf("bob@partner.example")).toMatchObject({
      role: "member",
    });
    // Only the verified ID token is kept, not Access's access token.
    const [account] = await accessAccountsOf("bob@partner.example");
    expect(account).toMatchObject({
      accountId: "bob@partner.example",
      accessToken: null,
      refreshToken: null,
    });
  });

  it("refuses a callback in a browser that didn't start the sign-in (state)", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    const authorizationUrl = await start(new Browser());

    const attackerBrowser = new Browser();
    const callback = await finish(attackerBrowser, authorizationUrl, {
      email: "alice@acme.com",
    });
    expect(callback.status).toBe(302);
    expect(errorOf(callback)).toBe("state_mismatch");
    expect(attackerBrowser.has("better-auth.session_token")).toBe(false);
  });

  it("can't be handed a code issued for another sign-in (PKCE)", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");

    // The victim's browser starts a sign-in; an attacker gets a code for
    // their own, separate sign-in and plants it in the victim's callback.
    const victim = new Browser();
    const victimUrl = await start(victim);
    const attackerCode = access
      .authorize(await start(new Browser()), { email: "alice@acme.com" })
      .searchParams.get("code")!;
    const planted = new URL(
      `${GATEWAY_URL}/api/auth/callback/cloudflare-access`,
    );
    planted.searchParams.set("code", attackerCode);
    planted.searchParams.set(
      "state",
      new URL(victimUrl).searchParams.get("state")!,
    );

    const callback = await send(planted.toString(), { browser: victim });
    expect(errorOf(callback)).toBe("invalid_code");
    expect(victim.has("better-auth.session_token")).toBe(false);
  });

  it("refuses an ID token for another client, or one that says the email isn't verified", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");

    for (const claims of [
      { aud: "another-client-id" },
      { email_verified: false },
      { iss: "https://evil.cloudflareaccess.com/cdn-cgi/access/sso/oidc/x" },
    ]) {
      const browser = new Browser();
      const callback = await finish(browser, await start(browser), {
        email: "alice@acme.com",
        claims,
      });
      expect(errorOf(callback)).toBe("unable_to_get_user_info");
      expect(browser.has("better-auth.session_token")).toBe(false);
    }
  });

  it("refuses a stranger without creating an account", async () => {
    await claimGateway();
    const browser = new Browser();
    const callback = await finish(browser, await start(browser), {
      email: "mallory@evil.example",
    });
    expect(callback.headers.get("location")).toMatch(/^\/sign-in\?/);
    expect(errorOf(callback)).toBe("ACCESS_NOT_INVITED");
    expect(await userByEmail("mallory@evil.example")).toBeUndefined();
  });

  it("refuses everyone on a gateway nobody has claimed", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.oidc,
      CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: "acme.com",
    });
    const browser = new Browser();
    const callback = await finish(browser, await start(browser), {
      email: "first@acme.com",
    });
    expect(errorOf(callback)).toBe("ACCESS_NOT_SET_UP");
    expect(await db.select().from(users)).toEqual([]);
  });

  it("keeps a deactivated member out", async () => {
    const owner = await claimGateway();
    const userId = await seedVerifiedMember(
      owner.organizationId,
      "gone@acme.com",
    );
    await UserRepository.deactivate(userId, "test");
    const browser = new Browser();
    const callback = await finish(browser, await start(browser), {
      email: "gone@acme.com",
    });
    // Better Auth's admin plugin refuses a banned user's session first; the
    // Access membership check refuses it too (ACCESS_ACCOUNT_DEACTIVATED).
    expect(errorOf(callback)).toBe("BANNED_USER");
    expect(browser.has("better-auth.session_token")).toBe(false);
  });

  it("auto-joins an allowed domain through OIDC, but never 'everyone'", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.oidc,
      CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: "acme.com",
      // Outer-ring only: it means nothing for OIDC sign-in.
      CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN: "everyone",
    });
    const owner = await claimGateway();
    const appId = await seedDefaultApp(owner.organizationId);

    const joined = new Browser();
    await finish(joined, await start(joined), { email: "carol@acme.com" });
    expect(await membershipOf("carol@acme.com")).toMatchObject({
      organizationId: owner.organizationId,
      role: "member",
    });
    expect(
      await grantedAppsOf((await userByEmail("carol@acme.com"))!.id),
    ).toEqual([appId]);

    const stranger = new Browser();
    const refused = await finish(stranger, await start(stranger), {
      email: "frank@anywhere.example",
    });
    expect(errorOf(refused)).toBe("ACCESS_NOT_INVITED");
  });

  it("links an existing account only when its email is verified, else after a password sign-in", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");

    // Verified email: linked and signed in.
    const alice = new Browser();
    const signedIn = await finish(alice, await start(alice), {
      email: "alice@acme.com",
    });
    expect(signedIn.headers.get("location")).toBe("/");
    expect(await accessAccountsOf("alice@acme.com")).toHaveLength(1);

    // The owner's email was never verified: no takeover by email alone.
    const ownerBrowser = new Browser();
    const refused = await finish(ownerBrowser, await start(ownerBrowser), {
      email: OWNER.email,
    });
    expect(errorOf(refused)).toBe("account_not_linked");
    expect(await accessAccountsOf(OWNER.email)).toEqual([]);

    // Signed in with the password, the owner links Access themselves.
    await passwordSignIn(ownerBrowser, OWNER.email, OWNER.password);
    const linkResponse = await api("/link-social", {
      method: "POST",
      browser: ownerBrowser,
      body: { provider: "cloudflare-access", callbackURL: "/" },
    });
    const { url } = (await linkResponse.json()) as { url: string };
    const linked = await finish(ownerBrowser, url, { email: OWNER.email });
    expect(linked.headers.get("location")).toBe("/");
    expect(await accessAccountsOf(OWNER.email)).toHaveLength(1);

    // Next time, Access alone signs the owner in.
    const fresh = new Browser();
    const next = await finish(fresh, await start(fresh), {
      email: OWNER.email,
    });
    expect(next.headers.get("location")).toBe("/");
    await expect(
      (await api("/get-session", { browser: fresh })).json(),
    ).resolves.toMatchObject({ user: { id: owner.userId } });
  });

  it("won't link a different email to a signed-in account", async () => {
    await claimGateway();
    const browser = new Browser();
    await passwordSignIn(browser, OWNER.email, OWNER.password);
    const linkResponse = await api("/link-social", {
      method: "POST",
      browser,
      body: { provider: "cloudflare-access", callbackURL: "/" },
    });
    const { url } = (await linkResponse.json()) as { url: string };
    const callback = await finish(browser, url, {
      email: "someone-else@acme.com",
    });
    expect(errorOf(callback)).toBe("email_does_not_match");
    expect(await accessAccountsOf(OWNER.email)).toEqual([]);
  });

  it("behind the outer ring too, signs in only the person Access vouches for", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.oidc,
      ...MOCK_ACCESS_ENV.outerRing,
      CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: "acme.com",
    });
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    await seedVerifiedMember(owner.organizationId, "bob@acme.com");
    const alice = await throughAccess("alice@acme.com");

    // Through the outer ring as Alice, "Continue with Company SSO" as Bob,
    // or as Erin, whom auto-join would let in: refused, nothing made.
    for (const email of ["bob@acme.com", "erin@acme.com"]) {
      const browser = new Browser();
      const authorizationUrl = await start(browser, {}, alice);
      const callback = await send(
        access.authorize(authorizationUrl, { email }).toString(),
        { browser, headers: alice },
      );
      expect(errorOf(callback)).toBe("ACCESS_EMAIL_MISMATCH");
      expect(browser.has("better-auth.session_token")).toBe(false);
    }
    expect(await userByEmail("erin@acme.com")).toBeUndefined();

    // As herself, she is signed in.
    const browser = new Browser();
    const again = await start(browser, {}, alice);
    const signedIn = await send(
      access.authorize(again, { email: "alice@acme.com" }).toString(),
      { browser, headers: alice },
    );
    expect(signedIn.headers.get("location")).toBe("/");
    await expect(
      (await api("/get-session", { browser, headers: alice })).json(),
    ).resolves.toMatchObject({ user: { email: "alice@acme.com" } });
  });

  it("doesn't take a posted ID token as a sign-in", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    const browser = new Browser();
    const response = await api("/sign-in/social", {
      method: "POST",
      browser,
      body: {
        provider: "cloudflare-access",
        idToken: { token: await access.idToken({ email: "alice@acme.com" }) },
      },
    });
    expect(response.status).toBe(404);
    expect(browser.has("better-auth.session_token")).toBe(false);
  });

  describe("login CSRF: a sign-in someone else started can't be finished in your browser", () => {
    /** An attacker's own sign-in, logged in at Access, its callback unused. */
    async function attackersCallback(
      body: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) {
      const attackerUrl = await start(new Browser(), body, headers);
      return access.authorize(attackerUrl, { email: "mallory@acme.com" });
    }

    it("closes Better Auth Expo's authorization proxy, which planted any state it was handed", async () => {
      const owner = await claimGateway();
      await seedVerifiedMember(owner.organizationId, "mallory@acme.com");
      await seedVerifiedMember(owner.organizationId, "alice@acme.com");

      // Alice is signed in in her browser.
      const victim = new Browser();
      await finish(victim, await start(victim), { email: "alice@acme.com" });

      // The attacker's state, through the proxy, to an https page of theirs
      // or to Access's own endpoint (with a bogus client_id, so Access stops
      // on an error page and the state stays unused).
      const callback = await attackersCallback();
      const state = callback.searchParams.get("state")!;
      for (const target of [
        `https://evil.example/hop?state=${state}`,
        `https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${OIDC_CLIENT_ID}/authorization?client_id=bogus&state=${state}`,
      ]) {
        const proxy = await navigate(
          `${GATEWAY_URL}/api/auth/expo-authorization-proxy?authorizationURL=${encodeURIComponent(target)}`,
          victim,
        );
        expect(proxy.status).toBe(404);
        expect(proxy.headers.get("location")).toBeNull();
        expect(proxy.headers.getSetCookie()).toEqual([]);
      }

      // The attacker's callback, opened in Alice's browser, fails: its state
      // isn't bound to her browser. She is still herself.
      const finished = await navigate(callback.toString(), victim);
      expect(errorOf(finished)).toBe("state_mismatch");
      await expect(
        (await navigate(`${GATEWAY_URL}/api/auth/get-session`, victim)).json(),
      ).resolves.toMatchObject({ user: { email: "alice@acme.com" } });
    });

    it("refuses the attacker's callback in a fresh browser, whatever the sign-in was for", async () => {
      const owner = await claimGateway();
      await seedVerifiedMember(owner.organizationId, "mallory@acme.com");
      for (const callback of [
        await attackersCallback(),
        // A sign-in the attacker started as the mobile app.
        await attackersCallback(
          {
            callbackURL: "everyapp:///",
            errorCallbackURL: "everyapp:///sign-in",
          },
          { origin: "everyapp://" },
        ),
      ]) {
        const victim = new Browser();
        const finished = await navigate(callback.toString(), victim);
        expect(errorOf(finished)).toBe("state_mismatch");
        // Back to wherever the sign-in said errors go, with no session.
        expect(
          new URL(
            finished.headers.get("location")!,
            GATEWAY_URL,
          ).searchParams.has("cookie"),
        ).toBe(false);
        expect(victim.has("better-auth.session_token")).toBe(false);
      }
    });

    it("can't link the victim's Access identity to the attacker's account", async () => {
      const owner = await claimGateway();
      await seedVerifiedMember(owner.organizationId, "alice@acme.com");
      // The attacker, signed in to an account of theirs, starts connecting
      // Access and gets the victim's browser to the Access login with it.
      const attacker = new Browser();
      await passwordSignIn(attacker, OWNER.email, OWNER.password);
      const linkResponse = await api("/link-social", {
        method: "POST",
        browser: attacker,
        body: { provider: "cloudflare-access", callbackURL: "/" },
      });
      const { url } = (await linkResponse.json()) as { url: string };
      const victim = new Browser();
      const finished = await navigate(
        access.authorize(url, { email: "alice@acme.com" }).toString(),
        victim,
      );
      expect(errorOf(finished)).toBe("state_mismatch");
      expect(await accessAccountsOf(OWNER.email)).toEqual([]);
      expect(await accessAccountsOf("alice@acme.com")).toEqual([]);
    });
  });
});

describe("the mobile app's sign-in: from the system browser to the app (SQLite)", () => {
  beforeEach(() => {
    useAccessEnv(MOCK_ACCESS_ENV.oidc);
  });

  const APP = { origin: "everyapp://", "cf-connecting-ip": "198.51.100.7" };

  /** The app asks to start: a link for the system browser and a secret. */
  async function startInApp(
    app: Browser,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = APP,
  ) {
    const response = await api("/mobile-sign-in/start", {
      method: "POST",
      browser: app,
      body: {
        provider: "cloudflare-access",
        redirectURL: "everyapp:///sign-in",
        ...body,
      },
      headers,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()) as { url: string; secret: string };
  }

  /** The app opens the link in the system browser, which goes to Access. */
  async function openLink(browser: Browser, url: string) {
    const response = await navigate(url, browser, {
      "cf-connecting-ip": APP["cf-connecting-ip"],
      "sec-fetch-site": "none",
    });
    expect(response.status).toBe(302);
    return response.headers.get("location")!;
  }

  /** Log in at Access, and follow the callback back: the app's deep link. */
  async function callBack(
    browser: Browser,
    authorizationUrl: string,
    identity: MockIdentity,
  ): Promise<URL> {
    const response = await navigate(
      access.authorize(authorizationUrl, identity).toString(),
      browser,
    );
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location")!);
  }

  function finishInApp(app: Browser, code: string, secret: string) {
    return api("/mobile-sign-in/finish", {
      method: "POST",
      browser: app,
      body: { code, secret },
      headers: APP,
    });
  }

  it("hands the session to the app for a one-time code and its secret, never to the browser", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");

    const app = new Browser();
    const { url, secret } = await startInApp(app);
    expect(url).toMatch(
      new RegExp(
        `^${GATEWAY_URL}/api/auth/mobile-sign-in/continue\\?id=[A-Za-z0-9_-]{32}$`,
      ),
    );
    expect(url).not.toContain(secret);

    // In the system browser: Better Auth's own state (bound to this
    // browser) and PKCE, then Access.
    const browser = new Browser();
    const authorizationUrl = await openLink(browser, url);
    expect(
      Object.fromEntries(new URL(authorizationUrl).searchParams),
    ).toMatchObject({
      client_id: OIDC_CLIENT_ID,
      redirect_uri: `${GATEWAY_URL}/api/auth/callback/cloudflare-access`,
      code_challenge_method: "S256",
    });
    expect(browser.has("better-auth.state")).toBe(true);

    // Back to the app with a code; the browser keeps no session, and the
    // link carries no cookie.
    const deepLink = await callBack(browser, authorizationUrl, {
      email: "alice@acme.com",
    });
    expect(deepLink.toString()).toMatch(
      /^everyapp:\/\/\/sign-in\?code=[A-Za-z0-9_-]{32}$/,
    );
    expect(browser.has("better-auth.session_token")).toBe(false);
    await expect(
      (await navigate(`${GATEWAY_URL}/api/auth/get-session`, browser)).json(),
    ).resolves.toBeNull();

    // The app trades the code and its secret for the session.
    const code = deepLink.searchParams.get("code")!;
    const finished = await finishInApp(app, code, secret);
    expect(finished.status).toBe(200);
    await expect(finished.json()).resolves.toMatchObject({
      user: { email: "alice@acme.com" },
    });
    expect(app.has("better-auth.session_token")).toBe(true);
    await expect(
      (await api("/get-session", { browser: app })).json(),
    ).resolves.toMatchObject({
      user: { email: "alice@acme.com" },
      session: { activeOrganizationId: owner.organizationId },
    });

    // Once only.
    const again = await finishInApp(new Browser(), code, secret);
    expect(again.status).toBe(400);
    await expect(again.json()).resolves.toMatchObject({
      code: "INVALID_MOBILE_SIGN_IN_CODE",
    });
  });

  it("won't trade a code without the secret of the sign-in it came from", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    const app = new Browser();
    const { url, secret } = await startInApp(app);
    const browser = new Browser();
    const deepLink = await callBack(browser, await openLink(browser, url), {
      email: "alice@acme.com",
    });
    const code = deepLink.searchParams.get("code")!;

    // Whoever got hold of the code (another app on the device, say) has
    // only the secret of a sign-in of their own: refused, and the code is
    // spent.
    const { secret: otherSecret } = await startInApp(new Browser());
    const intercepted = new Browser();
    expect((await finishInApp(intercepted, code, otherSecret)).status).toBe(
      400,
    );
    expect(intercepted.has("better-auth.session_token")).toBe(false);
    expect((await finishInApp(app, code, secret)).status).toBe(400);
    expect(app.has("better-auth.session_token")).toBe(false);
  });

  it("sends the app the reason a sign-in was refused, and nothing to trade", async () => {
    await claimGateway();
    const app = new Browser();
    const { url } = await startInApp(app);
    const browser = new Browser();
    const deepLink = await callBack(browser, await openLink(browser, url), {
      email: "mallory@evil.example",
    });
    expect(deepLink.toString()).toBe(
      "everyapp:///sign-in?error=ACCESS_NOT_INVITED",
    );
    expect(browser.has("better-auth.session_token")).toBe(false);
    expect(await userByEmail("mallory@evil.example")).toBeUndefined();
  });

  it("asks first when it wasn't the app that opened the link", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    // An attacker starts a sign-in of their own (they hold its secret) and
    // gets Alice to open the link, from a page of theirs or on her own
    // network, hoping her browser signs her in and the code reaches them.
    const { url } = await startInApp(
      new Browser(),
      {},
      {
        origin: "everyapp://",
        "cf-connecting-ip": "203.0.113.66",
      },
    );
    for (const headers of [
      { "sec-fetch-site": "cross-site", "cf-connecting-ip": "203.0.113.66" },
      { "sec-fetch-site": "none", "cf-connecting-ip": "198.51.100.7" },
    ]) {
      const victim = new Browser();
      const response = await navigate(url, victim, headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
      const html = await response.text();
      expect(html).toContain("Sign in to the Every App app?");
      expect(html).toContain('method="post"');
      // Nothing started: no state in her browser, the link still unused.
      expect(victim.has("better-auth.state")).toBe(false);
    }

    // The page's own form (same origin) goes on; a form posted from
    // another site doesn't.
    const id = new URL(url).searchParams.get("id")!;
    const postForm = async (
      browser: Browser,
      headers: Record<string, string>,
    ) => {
      const response = await createAuth().handler(
        new Request(`${GATEWAY_URL}/api/auth/mobile-sign-in/continue`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...headers,
          },
          body: new URLSearchParams({ id }).toString(),
        }),
      );
      browser.store(response);
      return response;
    };
    const forgeries: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "null", "sec-fetch-site": "cross-site" },
    ];
    for (const headers of forgeries) {
      const forged = await postForm(new Browser(), headers);
      expect(forged.status).toBe(403);
    }
    // The page sends no Referer, so browsers post its form with
    // `Origin: null`; Fetch Metadata says it's the page's own.
    const confirmed = new Browser();
    const goOn = await postForm(confirmed, {
      origin: "null",
      "sec-fetch-site": "same-origin",
    });
    expect(goOn.status).toBe(302);
    expect(goOn.headers.get("location")).toMatch(
      /^https:\/\/acme\.cloudflareaccess\.com\//,
    );
    expect(confirmed.has("better-auth.state")).toBe(true);
  });

  it("opens a link in one browser only, and not after it expires", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    const { url } = await startInApp(new Browser());
    await openLink(new Browser(), url);
    const second = await navigate(url, new Browser(), {
      "cf-connecting-ip": APP["cf-connecting-ip"],
    });
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("This sign-in link has expired");

    const { url: stale } = await startInApp(new Browser());
    await db.update(verifications).set({ expiresAt: new Date(Date.now() - 1) });
    const expired = await navigate(stale, new Browser(), {
      "cf-connecting-ip": APP["cf-connecting-ip"],
    });
    expect(expired.status).toBe(400);
  });

  it("won't trade a code once it has expired", async () => {
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");
    const app = new Browser();
    const { url, secret } = await startInApp(app);
    const browser = new Browser();
    const deepLink = await callBack(browser, await openLink(browser, url), {
      email: "alice@acme.com",
    });
    await db.update(verifications).set({ expiresAt: new Date(Date.now() - 1) });
    const finished = await finishInApp(
      app,
      deepLink.searchParams.get("code")!,
      secret,
    );
    expect(finished.status).toBe(400);
    expect(app.has("better-auth.session_token")).toBe(false);
  });

  it("limits the handoff's endpoints like a sign-in", () => {
    const plugin = createAuth().options.plugins.find(
      (candidate) => candidate.id === "cloudflare-access",
    ) as { rateLimit?: { pathMatcher(path: string): boolean; max: number }[] };
    const [rule] = plugin.rateLimit ?? [];
    for (const path of [
      "/mobile-sign-in/start",
      "/mobile-sign-in/continue",
      "/mobile-sign-in/finish",
    ]) {
      expect(rule?.pathMatcher(path)).toBe(true);
    }
    expect(rule?.pathMatcher("/get-session")).toBe(false);
    expect(rule?.max).toBe(3);
  });

  it("only sends codes to the app's own scheme, for the Access provider", async () => {
    await claimGateway();
    for (const redirectURL of [
      "https://evil.example/callback",
      "exp://192.168.1.10:8081/--/sign-in",
      "everyapp://user:pass@host/x",
      "not a url",
    ]) {
      const response = await api("/mobile-sign-in/start", {
        method: "POST",
        body: { provider: "cloudflare-access", redirectURL },
        headers: APP,
      });
      expect(response.status).toBe(400);
    }
    const otherProvider = await api("/mobile-sign-in/start", {
      method: "POST",
      body: { provider: "github", redirectURL: "everyapp:///sign-in" },
      headers: APP,
    });
    expect(otherProvider.status).toBe(404);

    // Without OIDC sign-in configured there is nothing to start.
    useAccessEnv(MOCK_ACCESS_ENV.outerRing);
    const off = await api("/mobile-sign-in/start", {
      method: "POST",
      body: {
        provider: "cloudflare-access",
        redirectURL: "everyapp:///sign-in",
      },
      headers: APP,
    });
    expect(off.status).toBe(404);
  });
});

describe("account linking stays safe with another provider (SQLite)", () => {
  it("never links an existing account through a provider that isn't trusted", async () => {
    useAccessEnv(MOCK_ACCESS_ENV.oidc);
    const owner = await claimGateway();
    await seedVerifiedMember(owner.organizationId, "alice@acme.com");

    // The real configuration plus a second, untrusted OIDC provider whose
    // users' emails it doesn't vouch for.
    const base = createAuth();
    const withOther = betterAuth({
      ...base.options,
      plugins: [
        ...base.options.plugins,
        genericOAuth({
          config: [
            {
              providerId: "other-idp",
              clientId: "other",
              clientSecret: "other-secret",
              authorizationUrl: "https://idp.other.example/authorize",
              tokenUrl: "https://idp.other.example/token",
              getUserInfo: async () => ({
                id: "other-123",
                email: "alice@acme.com",
                emailVerified: false,
                name: "Not Alice",
              }),
            },
          ],
        }),
      ],
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "idp.other.example") {
        return Response.json({ access_token: "t", token_type: "Bearer" });
      }
      return access.fetch(input);
    });

    const browser = new Browser();
    const started = await withOther.handler(
      new Request(`${GATEWAY_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { origin: GATEWAY_URL, "content-type": "application/json" },
        body: JSON.stringify({
          provider: "other-idp",
          callbackURL: "/",
          errorCallbackURL: "/sign-in",
        }),
      }),
    );
    browser.store(started);
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    const callback = await withOther.handler(
      new Request(
        `${GATEWAY_URL}/api/auth/callback/other-idp?code=c&state=${state}`,
        { headers: { cookie: browser.header() } },
      ),
    );
    expect(
      new URL(callback.headers.get("location")!, GATEWAY_URL).searchParams.get(
        "error",
      ),
    ).toBe("account_not_linked");
    const [alice] = await db
      .select()
      .from(users)
      .where(eq(users.email, "alice@acme.com"));
    expect(
      await db.select().from(accounts).where(eq(accounts.userId, alice!.id)),
    ).toEqual([]);
  });
});

describe("password sign-in switched off (SQLite)", () => {
  it("takes effect once an owner can sign in with Access, and never blocks the setup claim", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.oidc,
      EMAIL_PASSWORD_SIGN_IN: "false",
    });
    // The owner's account comes from the setup link, server-side.
    await expect(claimGateway()).resolves.toMatchObject({
      userId: expect.any(String),
    });

    // Until the owner has connected Access, passwords stay on: turning them
    // off now would lock the owner out.
    const owner = new Browser();
    expect(
      (await passwordSignIn(owner, OWNER.email, OWNER.password)).status,
    ).toBe(200);
    await expect((await api("/sign-in-methods")).json()).resolves.toMatchObject(
      { emailPassword: true },
    );

    // The owner connects Access while signed in...
    const linkResponse = await api("/link-social", {
      method: "POST",
      browser: owner,
      body: { provider: "cloudflare-access", callbackURL: "/" },
    });
    const { url } = (await linkResponse.json()) as { url: string };
    await send(access.authorize(url, { email: OWNER.email }).toString(), {
      browser: owner,
    });
    expect(await accessAccountsOf(OWNER.email)).toHaveLength(1);

    // ...and from then on nobody signs in, signs up or resets with a password.
    const refused = await passwordSignIn(
      new Browser(),
      OWNER.email,
      OWNER.password,
    );
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      code: "PASSWORD_SIGN_IN_DISABLED",
    });
    expect(
      (
        await api("/request-password-reset", {
          method: "POST",
          body: { email: OWNER.email, redirectTo: "/reset-password" },
        })
      ).status,
    ).toBe(403);
    await expect((await api("/sign-in-methods")).json()).resolves.toMatchObject(
      { emailPassword: false },
    );
  });

  it("won't hand out password reset links while passwords are off", async () => {
    useAccessEnv({
      ...MOCK_ACCESS_ENV.outerRing,
      EMAIL_PASSWORD_SIGN_IN: "false",
    });
    const owner = await claimGateway();
    const memberId = await seedVerifiedMember(
      owner.organizationId,
      "alice@acme.com",
    );
    const ownerCtx = {
      orgId: owner.organizationId,
      userId: owner.userId,
      role: "owner" as const,
    };
    // Passwords are still on: the owner hasn't connected Access yet.
    await expect(
      MembershipService.createPasswordResetLink(ownerCtx, memberId),
    ).resolves.toMatchObject({ email: "alice@acme.com" });

    // The owner signs in with the password through the outer ring: linked.
    const browser = new Browser();
    await passwordSignIn(
      browser,
      OWNER.email,
      OWNER.password,
      await throughAccess(OWNER.email),
    );
    await send(`${GATEWAY_URL}/api/auth/get-session`, {
      browser,
      headers: {
        "cf-access-jwt-assertion": await access.assertion({
          email: OWNER.email,
        }),
      },
    });
    await expect(
      MembershipService.createPasswordResetLink(ownerCtx, memberId),
    ).rejects.toMatchObject({ code: "PASSWORD_SIGN_IN_DISABLED" });
  });

  it("keeps passwords on when no other way to sign in is configured", async () => {
    useAccessEnv({ EMAIL_PASSWORD_SIGN_IN: "false" });
    await claimGateway();
    const response = await passwordSignIn(
      new Browser(),
      OWNER.email,
      OWNER.password,
    );
    expect(response.status).toBe(200);
    await expect((await api("/sign-in-methods")).json()).resolves.toMatchObject(
      { emailPassword: true, providers: [] },
    );
  });
});

describe("the membership policy itself (SQLite)", () => {
  const config = readAccessConfig(
    { ...MOCK_ACCESS_ENV.outerRing },
    { allowLoopback: false },
  );

  it("refuses a deactivated member, whatever Better Auth's own checks do", async () => {
    const owner = await claimGateway();
    const userId = await seedVerifiedMember(
      owner.organizationId,
      "gone@acme.com",
    );
    await UserRepository.deactivate(userId, "test");
    await expect(
      ensureAccessMembership(userId, "outer-ring", config),
    ).rejects.toMatchObject({
      body: { code: "ACCESS_ACCOUNT_DEACTIVATED" },
    });
  });

  it("never lets an account whose email isn't verified join", async () => {
    await claimGateway();
    await db.insert(users).values({
      id: "user-unverified",
      name: "Unverified",
      email: "unverified@acme.com",
      emailVerified: false,
    });
    await expect(
      ensureAccessMembership("user-unverified", "outer-ring", {
        ...config,
        autoJoinDomains: ["acme.com"],
      }),
    ).rejects.toMatchObject({ body: { code: "ACCESS_NOT_INVITED" } });
    expect(await membershipOf("unverified@acme.com")).toBeUndefined();
  });

  it("uses an invitation once, however many sign-ins race for it", async () => {
    const owner = await claimGateway();
    await inviteAs(owner, "bob@partner.example");
    await db.insert(users).values({
      id: "user-bob",
      name: "Bob",
      email: "bob@partner.example",
      emailVerified: true,
    });

    const results = await Promise.allSettled([
      ensureAccessMembership("user-bob", "oidc", config),
      ensureAccessMembership("user-bob", "oidc", config),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(
      await db.select().from(members).where(eq(members.userId, "user-bob")),
    ).toHaveLength(1);
  });

  it("only signs people in through Access for the Access provider's callback and the session check", () => {
    expect(accessSignInMode({ path: "/get-session" })).toBe("outer-ring");
    expect(
      accessSignInMode({
        path: "/callback/:id",
        params: { id: "cloudflare-access" },
      }),
    ).toBe("oidc");
    for (const ctx of [
      { path: "/callback/:id", params: { id: "other-idp" } },
      { path: "/sign-in/email" },
      { path: "/sign-up/email" },
      null,
      undefined,
    ]) {
      expect(accessSignInMode(ctx)).toBeNull();
    }
  });
});
