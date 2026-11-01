/**
 * The outer ring across the perimeter, in process: the real worker entry
 * (server.ts) and the real Better Auth configuration on SQLite, an app behind
 * its service binding, and a mock Cloudflare Access in front. An app host
 * honours a session only when it is the person Access vouches for on the
 * request (paths Access lets through without a login included), personal
 * access tokens work as ever, and the app never sees Access's headers or
 * cookie.
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
// The worker entry's Better Auth instance lives for the whole file, so its
// database must follow each test's.
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
import { eq } from "drizzle-orm";
import { createAuth } from "@/auth";
import { accounts, members, ownerSetupTokens, users } from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { AppAccessService } from "@/server/services/AppAccessService";
import { SetupService } from "@/server/services/SetupService";
import { UserPatService } from "@/server/services/UserPatService";
import {
  APPS_AUD,
  createMockAccess,
  MOCK_ACCESS_ENV,
  type MockAccess,
} from "@/test/mock-access";
import { deployLiveApp } from "@/test/registry";
import { createTestDb } from "@/test/sqlite-db";
import { clearJwksClientsForTests } from "./jwt";

const GATEWAY = "https://gateway.example.com";
const OWNER = {
  name: "Owner",
  email: "owner@acme.com",
  password: "owner-password-1",
};

let privateKeyPem: string;
let db: TestDb;
let access: MockAccess;
let appHost: string;
let ownerCookie: string;
let owner: { userId: string; organizationId: string };
/** What the app received, request by request. */
const received: Record<string, string>[] = [];

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
});

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: GATEWAY,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: privateKeyPem,
    DB: { prepare: () => undefined },
    ...MOCK_ACCESS_ENV.outerRing,
    // A separate Access application on the apps' hosts.
    CLOUDFLARE_ACCESS_APPS_AUD: APPS_AUD,
  });
  received.length = 0;
  clearHostnameCacheForTests();
  clearOrgContextCacheForTests();
  clearJwksClientsForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  db = await createTestDb();
  hoisted.testDb.current = db;
  access = await createMockAccess();
  vi.stubGlobal("fetch", access.fetch);

  await db.insert(ownerSetupTokens).values({
    id: "link-1",
    kind: "claim",
    tokenHash: createHash("sha256").update("est_setup").digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  owner = await SetupService.claimOwner({ token: "est_setup", ...OWNER });
  await db.insert(users).values({
    id: "user-alice",
    name: "Alice",
    email: "alice@acme.com",
    emailVerified: true,
  });
  await db.insert(members).values({
    id: "member-alice",
    organizationId: owner.organizationId,
    userId: "user-alice",
    role: "member",
    createdAt: new Date(),
  });
  // Live, as `everyapp deploy` leaves it: registered, uploaded, then
  // activated by the gateway's first request over the new binding.
  const { app: todo } = await deployLiveApp(db, {
    organizationId: owner.organizationId,
    appSlug: "todo",
    name: "Todos",
    description: "Things to do",
    manifest: {
      id: "todo",
      name: "Todos",
      // Its own MCP server answers /mcp, which the outer ring lets through
      // for it; the perimeter proxies the path with the identity.
      mcp: { by: "app", why: "Runs its own MCP server." },
    },
    deployerUserId: owner.userId,
    appBaseDomain: new URL(GATEWAY).host,
  });
  hoisted.env[`APP__${todo.workerName}`] = {
    fetch: async (request: Request) => {
      // The gateway's own catalog fetch, with its system token: not a
      // visitor's request, so not what the app "received" here.
      if (new URL(request.url).pathname === "/__everyapp/tools/list") {
        return new Response("not found", { status: 404 });
      }
      received.push(Object.fromEntries(request.headers));
      return new Response("todo app", {
        headers: { "content-type": "text/plain" },
      });
    },
  };
  appHost = todo.hostname!;
  await AppAccessService.updateAccessForApp(
    { orgId: owner.organizationId, userId: owner.userId, role: "owner" },
    todo.id,
    [owner.userId, "user-alice"],
  );

  // The owner signs in with the password, through Access.
  const signIn = await createAuth().handler(
    new Request(`${GATEWAY}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: GATEWAY,
        "content-type": "application/json",
        "cf-access-jwt-assertion": await access.assertion({
          email: OWNER.email,
        }),
      },
      body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
    }),
  );
  expect(signIn.status).toBe(200);
  ownerCookie = signIn.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
});

function openApp(headers: Record<string, string>): Promise<Response> {
  return server.fetch(
    new Request(`https://${appHost}/lists`, {
      headers: { host: appHost, accept: "text/html", ...headers },
    }),
  );
}

describe("the outer ring on app hosts (SQLite)", () => {
  it("serves the app to the person Access vouches for, without Access's headers or cookie", async () => {
    const assertion = await access.assertion({ email: OWNER.email });
    const response = await openApp({
      cookie: `${ownerCookie}; CF_Authorization=${assertion}`,
      "cf-access-jwt-assertion": assertion,
      "cf-access-authenticated-user-email": OWNER.email,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("todo app");

    const [headers] = received;
    expect(headers?.["x-everyapp-identity"]).toMatch(/^eyJ/);
    expect(headers).not.toHaveProperty("cookie");
    expect(
      Object.keys(headers ?? {}).filter((name) =>
        name.startsWith("cf-access-"),
      ),
    ).toEqual([]);
  });

  it("takes the assertion of the separate Access application on the apps' hosts", async () => {
    const appsAssertion = (email: string) =>
      access.assertion({ email, claims: { aud: [APPS_AUD] } });
    const served = await openApp({
      cookie: ownerCookie,
      "cf-access-jwt-assertion": await appsAssertion(OWNER.email),
    });
    expect(served.status).toBe(200);
    // It is verified like any other: someone else's sends the browser back.
    const other = await openApp({
      cookie: ownerCookie,
      "cf-access-jwt-assertion": await appsAssertion("alice@acme.com"),
    });
    expect(other.status).toBe(302);
    expect(received).toHaveLength(1);
  });

  it("sends someone whose session isn't the Access user's back to sign in", async () => {
    const response = await openApp({
      cookie: ownerCookie,
      "cf-access-jwt-assertion": await access.assertion({
        email: "alice@acme.com",
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${GATEWAY}/sign-in?return_to=${encodeURIComponent(`https://${appHost}/lists`)}`,
    );
    expect(received).toEqual([]);
  });

  it("doesn't let a session through without Access's word for that person", async () => {
    // Someone the Access policy no longer lets in still has the gateway's
    // session cookie: on its own, or with a header that proves nothing,
    // it gets them nowhere.
    const variants: Record<string, string>[] = [
      {},
      { "cf-access-jwt-assertion": "not-a-jwt" },
    ];
    for (const extra of variants) {
      const response = await openApp({ cookie: ownerCookie, ...extra });
      expect(response.status).toBe(302);
    }
    expect(received).toEqual([]);
  });

  it("checks a cookie session on a path Access lets through, by its CF_Authorization cookie", async () => {
    // An app host's /mcp is bypassed at Access where the manifest opts in
    // (MCP clients use tokens), but the session cookie works there too:
    // browsers send Access's own CF_Authorization cookie with it.
    const mcp = (headers: Record<string, string>) =>
      server.fetch(
        new Request(`https://${appHost}/mcp`, {
          method: "POST",
          headers: {
            host: appHost,
            origin: `https://${appHost}`,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
    const assertion = await access.assertion({ email: OWNER.email });

    expect((await mcp({ cookie: ownerCookie })).status).toBe(401);
    expect(received).toEqual([]);
    const vouched = await mcp({
      cookie: `${ownerCookie}; CF_Authorization=${assertion}`,
    });
    expect(vouched.status).toBe(200);
    expect(await vouched.text()).toBe("todo app");
    expect(received.at(-1)?.["x-everyapp-identity"]).toMatch(/^eyJ/);

    // A personal access token doesn't pass through Access at all, and
    // works as it always has.
    const { plaintext } = await UserPatService.create({
      userId: owner.userId,
      organizationId: owner.organizationId,
      name: "a script",
    });
    const withToken = await mcp({ authorization: `Bearer ${plaintext}` });
    expect(withToken.status).toBe(200);
    expect(await withToken.text()).toBe("todo app");
  });

  it("never treats the assertion itself as a session", async () => {
    // Access let Alice through, but she has no Better Auth session yet: the
    // app host sends her to the gateway, where the outer ring signs her in.
    const response = await openApp({
      "cf-access-jwt-assertion": await access.assertion({
        email: "alice@acme.com",
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      new RegExp(`^${GATEWAY}/sign-in\\?return_to=`),
    );
    expect(received).toEqual([]);
  });

  it("serves the gateway's /mcp to the person Access vouches for, once the outer ring has linked them", async () => {
    // With Access's Managed OAuth on the gateway's host, an AI app's request
    // reaches /mcp with the person's assertion and no gateway credential.
    const assertion = await access.assertion({ email: OWNER.email });
    const gatewayHost = new URL(GATEWAY).host;
    const listTools = () =>
      server.fetch(
        new Request(`${GATEWAY}/mcp`, {
          method: "POST",
          headers: {
            host: gatewayHost,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/list",
            "cf-access-jwt-assertion": assertion,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {
                  name: "test",
                  version: "1",
                },
              },
            },
          }),
        }),
      );
    const linkedAccounts = () =>
      db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.providerId, "cloudflare-access"));

    // The owner signed in with a password: the Access identity isn't linked
    // to the account yet, and /mcp hands nothing to a bare email.
    expect(await linkedAccounts()).toEqual([]);
    const before = await listTools();
    expect(before.status).toBe(403);
    expect(await before.json()).toMatchObject({
      error: "forbidden",
      reason: "not_connected",
      message: expect.stringContaining(GATEWAY),
    });

    // The browser's session check on the gateway, through the outer ring as
    // the same person: that links the identity.
    const check = await createAuth().handler(
      new Request(`${GATEWAY}/api/auth/get-session`, {
        headers: {
          host: gatewayHost,
          cookie: ownerCookie,
          "cf-access-jwt-assertion": assertion,
        },
      }),
    );
    expect(check.status).toBe(200);
    expect(await linkedAccounts()).toEqual([{ userId: owner.userId }]);

    const after = await listTools();
    expect(after.status).toBe(200);
    const body = (await after.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(body.result.tools.map((tool) => tool.name)).toContain(
      "everyapp_whoami",
    );
    // The gateway's own catalog fetch, with its system token, is all the
    // app saw: /mcp proxied nothing to it.
    expect(received).toEqual([]);
  });
});
