/**
 * Third-party app hosts with per-host sessions, in process: the real
 * worker entry (server.ts) and Better Auth on SQLite, on a hosted gateway
 * at app.everyapp.com whose third-party domain is everyapp.dev. Acme has
 * two dispatch apps (registered by the deploy API's own rules) behind a
 * fake DISPATCHER; the platform organization has a shared first-party app.
 *
 * The handoff (app host → control plane → code → app host session) works
 * end to end; a code is single-use, short-lived, and good only on its host,
 * for its app, in the browser that started the handoff; the Better Auth
 * cookie is never honoured on a third-party host, nor the host session on
 * any other host; signing out, losing the membership or the app ends the
 * host session; app responses can't grant credentialed CORS or set the
 * perimeter's cookies; and a self-hosted gateway has no third-party hosts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {} as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(hoisted.testDb), schema };
});
vi.mock("drizzle-orm/d1", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { drizzle: () => testDbProxy(hoisted.testDb) };
});
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: async () => new Response("control plane") },
}));

import { createHash, generateKeyPairSync } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import {
  HOST_NONCE_COOKIE,
  HOST_SESSION_COOKIE,
  hostAdmitsApp,
  routeHost,
} from "@every-app/perimeter";
import { createAuth } from "@/auth";
import {
  accounts,
  apps,
  members,
  organizations,
  ownerSetupTokens,
  userAppAccess,
  users,
} from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { hostProfile, thirdPartyDomain } from "@/server/app-hosts";
import {
  recordDispatchDeployed,
  registerDispatchApp,
} from "@/server/deploy/registry";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { SetupService } from "@/server/services/SetupService";
import { UserPatService } from "@/server/services/UserPatService";
import { deployLiveApp } from "@/test/registry";
import { createTestDb } from "@/test/sqlite-db";

const GATEWAY = "https://app.everyapp.com";
const BASE = "app.everyapp.com";
const TODO_HOST = "todo-acme.everyapp.dev";
const NOTES_HOST = "notes-acme.everyapp.dev";
const PASSWORD = "a-password-for-tests";

let privateKeyPem: string;
let db: TestDb;
const received: Array<{ app: string; identity: string | null }> = [];

type Person = { userId: string; email: string };
let acme: string;
let other: string;
/** Acme's owner, who deployed both apps. */
let alice: Person;
/** An Acme member the apps aren't installed for. */
let bob: Person;
/** A member of another organization only. */
let carol: Person;
const rows: Record<"todo" | "notes", string> = { todo: "", notes: "" };
let sharedHost: string;

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
});

async function addOrganization(slug: string): Promise<string> {
  const id = `org-${slug}`;
  await db
    .insert(organizations)
    .values({ id, name: slug, slug, createdAt: new Date() });
  return id;
}

async function addPerson(name: string): Promise<Person> {
  const userId = `user-${name}`;
  const email = `${name}@example.com`;
  await db
    .insert(users)
    .values({ id: userId, name, email, emailVerified: true });
  await db.insert(accounts).values({
    id: `account-${name}`,
    accountId: userId,
    providerId: "credential",
    userId,
    password: await hashPassword(PASSWORD),
  });
  return { userId, email };
}

async function join(organizationId: string, userId: string, role: string) {
  await db.insert(members).values({
    id: `member-${organizationId}-${userId}`,
    organizationId,
    userId,
    role,
    createdAt: new Date(),
  });
}

/** The Better Auth session cookie, as the gateway's sign-in sets it. */
async function signIn(email: string): Promise<string> {
  const response = await createAuth().handler(
    new Request(`${GATEWAY}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: GATEWAY, "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  return cookiePairs(response);
}

function cookiePairs(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => !pair!.endsWith("="))
    .join("; ");
}

function cookieValue(response: Response, name: string): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    if (pair!.startsWith(`${name}=`)) return pair!.slice(name.length + 1);
  }
  return null;
}

function get(url: string, headers: Record<string, string> = {}) {
  return server.fetch(
    new Request(url, { headers: { host: new URL(url).host, ...headers } }),
  );
}

const PAGE = { accept: "text/html" };

function postStart(cookie: string, form: Record<string, string>) {
  return server.fetch(
    new Request(`${GATEWAY}/app-session/start`, {
      method: "POST",
      headers: {
        host: BASE,
        cookie,
        origin: GATEWAY,
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

/** Steps 1 and 2: the app host's redirect, with its nonce. */
async function startOn(host: string, path = "/tasks?view=all") {
  const started = await get(`https://${host}${path}`, PAGE);
  expect(started.status).toBe(302);
  const location = new URL(started.headers.get("location")!);
  const nonce = cookieValue(started, HOST_NONCE_COOKIE);
  return { started, location, nonce: nonce! };
}

/** Steps 1 to 3: a code for this browser, as `/__everyapp/session` URL. */
async function codeFor(gatewayCookie: string, host = TODO_HOST, path?: string) {
  const { location, nonce } = await startOn(host, path);
  const issued = await postStart(gatewayCookie, {
    return_to: location.searchParams.get("return_to")!,
    nonce_hash: location.searchParams.get("nonce_hash")!,
  });
  expect(issued.status).toBe(303);
  return { exchange: issued.headers.get("location")!, nonce };
}

/** The whole handoff: the host session cookie for this person. */
async function hostSession(gatewayCookie: string, host = TODO_HOST) {
  const { exchange, nonce } = await codeFor(gatewayCookie, host);
  const exchanged = await get(exchange, {
    cookie: `${HOST_NONCE_COOKIE}=${nonce}`,
  });
  expect(exchanged.status).toBe(303);
  return `${HOST_SESSION_COOKIE}=${cookieValue(exchanged, HOST_SESSION_COOKIE)}`;
}

function lastIdentity() {
  const token = received.at(-1)?.identity;
  if (!token) throw new Error("the app received no identity");
  const { sub, org_id, org_role, aud } = decodeJwt(token);
  return { sub, org_id, org_role, aud };
}

function forgetCaches() {
  clearHostnameCacheForTests();
  clearOrgContextCacheForTests();
}

async function deployDispatchApp(slug: "todo" | "notes") {
  const plan = await registerDispatchApp({
    organizationId: acme,
    appSlug: slug,
    name: slug,
    description: slug,
    manifest: { id: slug, name: slug },
    deployerUserId: alice.userId,
    configuredThirdPartyDomain:
      (hoisted.env["THIRD_PARTY_DOMAIN"] as string | undefined) ?? null,
    appBaseDomain: BASE,
    thirdPartyDomain: thirdPartyDomain(hoisted.env),
  });
  await recordDispatchDeployed(plan.app.id, {
    versionId: `${slug}-version`,
    manifest: { id: slug, name: slug },
    actor: "deploy-key:test",
  });
  await db
    .update(apps)
    .set({ status: "active" })
    .where(eq(apps.id, plan.app.id));
  rows[slug] = plan.app.id;
  return plan.app;
}

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "hosted",
    GATEWAY_URL: GATEWAY,
    APP_BASE_DOMAIN: BASE,
    THIRD_PARTY_DOMAIN: "everyapp.dev",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: privateKeyPem,
    DB: { prepare: () => undefined },
    DISPATCHER: {
      get: (name: string) => ({
        fetch: async (request: Request) => {
          received.push({
            app: name,
            identity: request.headers.get("x-everyapp-identity"),
          });
          const headers = new Headers({
            "content-type": "text/plain",
            "access-control-allow-origin": "https://evil-other.everyapp.dev",
            "access-control-allow-credentials": "true",
          });
          headers.append("set-cookie", "prefs=dark; Path=/");
          headers.append(
            "set-cookie",
            `${HOST_SESSION_COOKIE}=planted; Path=/; Secure`,
          );
          headers.append("set-cookie", "__HOST-everyapp_n=x; Path=/; Secure");
          return new Response(`${name} app`, { headers });
        },
      }),
    },
  });
  received.length = 0;
  forgetCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  db = await createTestDb();
  hoisted.testDb.current = db;

  await db.insert(ownerSetupTokens).values({
    id: "link-1",
    kind: "claim",
    tokenHash: createHash("sha256").update("est_setup").digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const platform = await SetupService.claimOwner({
    token: "est_setup",
    name: "Platform",
    email: "platform@example.com",
    password: PASSWORD,
  });

  acme = await addOrganization("acme");
  other = await addOrganization("other");
  alice = await addPerson("alice");
  bob = await addPerson("bob");
  carol = await addPerson("carol");
  await join(acme, alice.userId, "owner");
  await join(acme, bob.userId, "member");
  await join(other, carol.userId, "owner");

  expect((await deployDispatchApp("todo")).hostname).toBe(TODO_HOST);
  expect((await deployDispatchApp("notes")).hostname).toBe(NOTES_HOST);

  const { app: shared } = await deployLiveApp(db, {
    organizationId: platform.organizationId,
    appSlug: "openseo",
    manifest: { id: "openseo" },
    deployerUserId: platform.userId,
    appBaseDomain: BASE,
    isInstallOrganization: true,
    scope: "shared",
  });
  sharedHost = shared.hostname!;
  hoisted.env[`APP__${shared.workerName}`] = {
    fetch: async (request: Request) => {
      received.push({
        app: "openseo",
        identity: request.headers.get("x-everyapp-identity"),
      });
      return new Response("openseo app");
    },
  };
});

describe("the host classifier", () => {
  const hosted = { gatewayHost: BASE, thirdPartyDomain: "everyapp.dev" };

  it("tells the control plane, first-party and third-party hosts apart", () => {
    expect(routeHost(BASE, hosted)).toEqual({ kind: "control_plane" });
    expect(routeHost("", hosted)).toEqual({ kind: "control_plane" });
    expect(routeHost(`openseo.${BASE}`, hosted)).toEqual({
      kind: "first_party",
    });
    expect(routeHost(TODO_HOST, hosted)).toEqual({ kind: "third_party" });
    for (const host of [
      "everyapp.dev",
      "a.b.everyapp.dev",
      "-bad.everyapp.dev",
      "todo-acme.everyapp.dev:8443",
    ]) {
      expect(routeHost(host, hosted).kind).not.toBe("third_party");
    }
    expect(routeHost("a.b.everyapp.dev", hosted)).toEqual({
      kind: "not_found",
    });
  });

  it("serves customer code on third-party hosts only, and first-party Workers nowhere else", () => {
    const dispatch = { tier: "dispatch", scope: "org" } as const;
    const binding = { tier: "service_binding", scope: "shared" } as const;
    expect(hostAdmitsApp({ kind: "third_party" }, dispatch)).toBe(true);
    expect(hostAdmitsApp({ kind: "first_party" }, dispatch)).toBe(false);
    expect(hostAdmitsApp({ kind: "third_party" }, binding)).toBe(false);
    expect(hostAdmitsApp({ kind: "first_party" }, binding)).toBe(true);
    expect(
      hostAdmitsApp(
        { kind: "third_party" },
        { tier: "dispatch", scope: "shared" },
      ),
    ).toBe(false);
  });

  it("has no third-party class on a self-hosted gateway, or with a domain that could share the gateway's site", () => {
    expect(hostProfile(hoisted.env, BASE)).toEqual(hosted);
    expect(
      hostProfile(
        { ...hoisted.env, GATEWAY_DEPLOYMENT_MODE: "self_hosted" },
        BASE,
      ),
    ).toEqual({ gatewayHost: BASE, thirdPartyDomain: null });
    expect(hostProfile(hoisted.env, null).thirdPartyDomain).toBeNull();
    for (const domain of [
      "everyapp.com",
      "apps.everyapp.com",
      "x.app.everyapp.com",
      "",
      "not a domain",
    ]) {
      expect(
        thirdPartyDomain({ ...hoisted.env, THIRD_PARTY_DOMAIN: domain }),
      ).toBeNull();
    }
    expect(
      thirdPartyDomain({ ...hoisted.env, THIRD_PARTY_DOMAIN: "EveryApp.Dev." }),
    ).toBe("everyapp.dev");
  });
});

describe("third-party hosts with per-host sessions (SQLite)", () => {
  it("hands a session from the control plane to the app host, and back to the page", async () => {
    const gatewayCookie = await signIn(alice.email);

    // 1. The app host: a nonce cookie and the way to the control plane.
    const { started, location, nonce } = await startOn(TODO_HOST);
    expect(location.origin).toBe(GATEWAY);
    expect(location.pathname).toBe("/app-session");
    expect(location.searchParams.get("return_to")).toBe(
      `https://${TODO_HOST}/tasks?view=all`,
    );
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [nonceCookie] = started.headers.getSetCookie();
    expect(nonceCookie).toMatch(
      /^__Host-everyapp_n=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    expect(received).toEqual([]);

    // 2. The control plane posts the handoff from its own origin.
    const continuePage = await get(location.toString(), {
      cookie: gatewayCookie,
    });
    expect(continuePage.status).toBe(200);
    const html = await continuePage.text();
    expect(html).toContain('action="/app-session/start"');
    expect(html).toContain(location.searchParams.get("nonce_hash")!);
    expect(continuePage.headers.get("content-security-policy")).toContain(
      `form-action 'self' https://${TODO_HOST}`,
    );
    expect(continuePage.headers.get("cache-control")).toBe("no-store");

    // 3. A code, back on the app host's exchange path.
    const issued = await postStart(gatewayCookie, {
      return_to: location.searchParams.get("return_to")!,
      nonce_hash: location.searchParams.get("nonce_hash")!,
    });
    expect(issued.status).toBe(303);
    const exchange = new URL(issued.headers.get("location")!);
    expect(exchange.origin).toBe(`https://${TODO_HOST}`);
    expect(exchange.pathname).toBe("/__everyapp/session");
    // The control plane never sets a cookie for the app host.
    expect(cookieValue(issued, HOST_SESSION_COOKIE)).toBeNull();

    // 4. The exchange sets the host session and clears the nonce.
    const exchanged = await get(exchange.toString(), {
      cookie: `${HOST_NONCE_COOKIE}=${nonce}`,
    });
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.get("location")).toBe("/tasks?view=all");
    const setCookies = exchanged.headers.getSetCookie();
    expect(setCookies[0]).toMatch(
      /^__Host-everyapp_s=v1\.[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400$/,
    );
    expect(setCookies[1]).toBe(
      "__Host-everyapp_n=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    expect(received).toEqual([]);

    // 5. The page, as Alice in Acme, for this app's Worker.
    const session = `${HOST_SESSION_COOKIE}=${cookieValue(exchanged, HOST_SESSION_COOKIE)}`;
    const page = await get(`https://${TODO_HOST}/tasks?view=all`, {
      cookie: session,
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("every-acme-todo app");
    expect(lastIdentity()).toEqual({
      sub: alice.userId,
      org_id: acme,
      org_role: "owner",
      aud: "every-acme-todo",
    });
  });

  it("sends a signed-out browser to sign in, and back to the handoff", async () => {
    const { location } = await startOn(TODO_HOST);
    const continuePage = await get(location.toString());
    expect(continuePage.status).toBe(303);
    const signIn = new URL(continuePage.headers.get("location")!, GATEWAY);
    expect(signIn.pathname).toBe("/sign-in");
    expect(signIn.searchParams.get("redirect")).toBe(
      `${location.pathname}${location.search}`,
    );
    // A request that isn't a page navigation is told it is unauthenticated.
    expect((await get(`https://${TODO_HOST}/api/tasks`)).status).toBe(401);
  });

  it("uses a code once, in the browser that started the handoff, on its own host, within 60 seconds", async () => {
    const gatewayCookie = await signIn(alice.email);

    // Another browser (no nonce, or another one) can't use the code: no
    // signing a victim in to someone else's account.
    const stolen = await codeFor(gatewayCookie);
    expect((await get(stolen.exchange)).status).toBe(400);
    const elsewhere = await startOn(TODO_HOST);
    const wrongNonce = await get(stolen.exchange, {
      cookie: `${HOST_NONCE_COOKIE}=${elsewhere.nonce}`,
    });
    expect(wrongNonce.status).toBe(400);
    expect(cookieValue(wrongNonce, HOST_SESSION_COOKIE)).toBeNull();

    // Once only.
    const first = await get(stolen.exchange, {
      cookie: `${HOST_NONCE_COOKIE}=${stolen.nonce}`,
    });
    expect(first.status).toBe(303);
    const replayed = await get(stolen.exchange, {
      cookie: `${HOST_NONCE_COOKIE}=${stolen.nonce}`,
    });
    expect(replayed.status).toBe(400);
    expect(cookieValue(replayed, HOST_SESSION_COOKIE)).toBeNull();

    // Only on the host (and for the app) it was issued for.
    const forTodo = await codeFor(gatewayCookie);
    const onNotes = new URL(forTodo.exchange);
    onNotes.host = NOTES_HOST;
    expect(
      (
        await get(onNotes.toString(), {
          cookie: `${HOST_NONCE_COOKIE}=${forTodo.nonce}`,
        })
      ).status,
    ).toBe(400);

    // Not after 60 seconds.
    const late = await codeFor(gatewayCookie);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
    try {
      expect(
        (
          await get(late.exchange, {
            cookie: `${HOST_NONCE_COOKIE}=${late.nonce}`,
          })
        ).status,
      ).toBe(400);
    } finally {
      vi.useRealTimers();
    }

    // A tampered code is no code.
    const tampered = await codeFor(gatewayCookie);
    const url = new URL(tampered.exchange);
    const [version, payload, mac] = url.searchParams.get("code")!.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    url.searchParams.set(
      "code",
      [
        version,
        Buffer.from(JSON.stringify({ ...claims, sub: bob.userId })).toString(
          "base64url",
        ),
        mac,
      ].join("."),
    );
    expect(
      (
        await get(url.toString(), {
          cookie: `${HOST_NONCE_COOKIE}=${tampered.nonce}`,
        })
      ).status,
    ).toBe(400);
  });

  it("sends no Referer from the code exchange, so the app never sees a code", async () => {
    const gatewayCookie = await signIn(alice.email);

    // The redirect's policy governs the navigation it starts.
    const { exchange, nonce } = await codeFor(gatewayCookie);
    const exchanged = await get(exchange, {
      cookie: `${HOST_NONCE_COOKIE}=${nonce}`,
    });
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.get("referrer-policy")).toBe("no-referrer");

    // So does the expired-link page's link back to the app.
    const replayed = await get(exchange, {
      cookie: `${HOST_NONCE_COOKIE}=${nonce}`,
    });
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toContain('<a href="/">');
    expect(replayed.headers.get("referrer-policy")).toBe("no-referrer");

    // The app's own pages keep the perimeter's default.
    const session = `${HOST_SESSION_COOKIE}=${cookieValue(exchanged, HOST_SESSION_COOKIE)}`;
    const page = await get(`https://${TODO_HOST}/tasks`, { cookie: session });
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("never honours the gateway's cookie on a third-party host, nor a host session anywhere else", async () => {
    const gatewayCookie = await signIn(alice.email);

    // The Better Auth cookie on the app host: a handoff, never the app.
    const withGatewayCookie = await get(`https://${TODO_HOST}/`, {
      ...PAGE,
      cookie: gatewayCookie,
    });
    expect(withGatewayCookie.status).toBe(302);
    expect(withGatewayCookie.headers.get("location")).toMatch(
      new RegExp(`^${GATEWAY}/app-session\\?`),
    );
    expect(
      (await get(`https://${TODO_HOST}/`, { cookie: gatewayCookie })).status,
    ).toBe(401);
    expect(received).toEqual([]);

    const todoSession = await hostSession(gatewayCookie);

    // The host session on a first-party host: sign in at the gateway.
    const onShared = await get(`https://${sharedHost}/`, {
      ...PAGE,
      cookie: todoSession,
    });
    expect(onShared.status).toBe(302);
    expect(onShared.headers.get("location")).toMatch(
      new RegExp(`^${GATEWAY}/sign-in\\?`),
    );
    // Nor on the control plane, which reads only its own cookie.
    const me = await get(`${GATEWAY}/api/auth/get-session`, {
      cookie: todoSession,
    });
    expect(await me.text()).not.toContain(alice.email);

    // Todo's session on Notes, another app of the same organization.
    expect(
      (await get(`https://${NOTES_HOST}/`, { cookie: todoSession })).status,
    ).toBe(401);
    expect(received).toEqual([]);

    // Two copies of the host session (cookie tossing) are refused.
    const tossed = await get(`https://${TODO_HOST}/`, {
      cookie: `${todoSession}; ${todoSession}`,
    });
    expect(tossed.status).toBe(401);
    expect(await tossed.json()).toMatchObject({
      reason: "duplicate_session_cookie",
    });
  });

  it("ends the host session with the gateway session, the membership or the app", async () => {
    const gatewayCookie = await signIn(alice.email);
    const session = await hostSession(gatewayCookie);
    const open = () => get(`https://${TODO_HOST}/`, { cookie: session });
    expect((await open()).status).toBe(200);

    // Signing out of the gateway.
    const signedOut = await createAuth().handler(
      new Request(`${GATEWAY}/api/auth/sign-out`, {
        method: "POST",
        headers: { origin: GATEWAY, cookie: gatewayCookie },
      }),
    );
    expect(signedOut.status).toBe(200);
    expect((await open()).status).toBe(401);

    // Losing the app.
    const again = await hostSession(await signIn(alice.email));
    const reopen = () => get(`https://${TODO_HOST}/`, { cookie: again });
    expect((await reopen()).status).toBe(200);
    await db
      .delete(userAppAccess)
      .where(
        and(
          eq(userAppAccess.userId, alice.userId),
          eq(userAppAccess.appRowId, rows.todo),
        ),
      );
    forgetCaches();
    const noApp = await reopen();
    expect(noApp.status).toBe(403);
    expect(await noApp.json()).toMatchObject({ reason: "no_app_access" });

    // Losing the membership.
    await db
      .delete(members)
      .where(
        and(eq(members.userId, alice.userId), eq(members.organizationId, acme)),
      );
    forgetCaches();
    expect((await reopen()).status).toBe(401);
  });

  it("issues no code to a member without the app, or to a non-member", async () => {
    for (const person of [bob, carol]) {
      const cookie = await signIn(person.email);
      const { location } = await startOn(TODO_HOST);
      const refused = await postStart(cookie, {
        return_to: location.searchParams.get("return_to")!,
        nonce_hash: location.searchParams.get("nonce_hash")!,
      });
      expect(refused.status).toBe(403);
      expect(refused.headers.get("location")).toBeNull();
    }

    // A cross-site post never reaches it (the control-plane guard).
    const aliceCookie = await signIn(alice.email);
    const { location } = await startOn(TODO_HOST);
    const forged = await server.fetch(
      new Request(`${GATEWAY}/app-session/start`, {
        method: "POST",
        headers: {
          host: BASE,
          cookie: aliceCookie,
          origin: `https://${TODO_HOST}`,
          "sec-fetch-site": "cross-site",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          return_to: location.searchParams.get("return_to")!,
          nonce_hash: location.searchParams.get("nonce_hash")!,
        }).toString(),
      }),
    );
    expect(forged.status).toBe(403);

    // Nor a code for a page on another domain, or for no app at all.
    for (const returnTo of [
      `https://todo.${BASE}/`,
      "https://evil.example/",
      "https://ghost-acme.everyapp.dev/",
    ]) {
      const response = await postStart(aliceCookie, {
        return_to: returnTo,
        nonce_hash: location.searchParams.get("nonce_hash")!,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("keeps an app from granting credentialed CORS or setting the perimeter's cookies", async () => {
    const session = await hostSession(await signIn(alice.email));
    const page = await get(`https://${TODO_HOST}/`, { cookie: session });
    expect(page.status).toBe(200);
    expect(page.headers.get("access-control-allow-credentials")).toBeNull();
    expect(page.headers.getSetCookie()).toEqual(["prefs=dark; Path=/"]);

    // A sibling app's page can't post with the visitor's host session.
    const forged = await server.fetch(
      new Request(`https://${TODO_HOST}/api/tasks`, {
        method: "POST",
        headers: {
          host: TODO_HOST,
          cookie: session,
          origin: "https://evil-other.everyapp.dev",
          "sec-fetch-site": "same-site",
        },
      }),
    );
    expect(forged.status).toBe(403);
  });

  it("lets a personal access token in under its own organization's rules", async () => {
    const { plaintext } = await UserPatService.create({
      userId: alice.userId,
      organizationId: acme,
      name: "a script",
    });
    const opened = await get(`https://${TODO_HOST}/`, {
      authorization: `Bearer ${plaintext}`,
    });
    expect(opened.status).toBe(200);
    expect(lastIdentity()).toMatchObject({ sub: alice.userId, org_id: acme });

    const { plaintext: carolToken } = await UserPatService.create({
      userId: carol.userId,
      organizationId: other,
      name: "a script",
    });
    expect(
      (
        await get(`https://${TODO_HOST}/`, {
          authorization: `Bearer ${carolToken}`,
        })
      ).status,
    ).toBe(403);
  });

  it("answers 404 for unknown third-party hosts, and 503 for a row on the wrong class of host", async () => {
    for (const host of [
      "ghost-acme.everyapp.dev",
      "everyapp.dev",
      "a.todo-acme.everyapp.dev",
    ]) {
      const response = await get(`https://${host}/`, PAGE);
      expect(response.status).toBe(404);
    }

    // A first-party Worker's row moved onto the third-party domain, and a
    // dispatch row onto the base domain: neither is served.
    await db
      .update(apps)
      .set({ hostname: "openseo-x.everyapp.dev" })
      .where(eq(apps.hostname, sharedHost));
    await db
      .update(apps)
      .set({ hostname: `notes.${BASE}` })
      .where(eq(apps.id, rows.notes));
    forgetCaches();
    expect((await get("https://openseo-x.everyapp.dev/")).status).toBe(503);
    expect((await get(`https://notes.${BASE}/`)).status).toBe(503);
    expect(received).toEqual([]);
  });

  it("has no third-party hosts or handoff on a self-hosted gateway", async () => {
    hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "self_hosted";
    forgetCaches();
    // The control plane's own paths, as before.
    const start = await get(`${GATEWAY}/app-session?return_to=x`);
    expect(await start.text()).toBe("control plane");
    // A dispatch row is never served on a self-hosted gateway's hosts.
    const response = await get(`https://${TODO_HOST}/`, PAGE);
    expect(response.status).toBe(503);
    expect(received).toEqual([]);
  });
});
