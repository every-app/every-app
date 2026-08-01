/**
 * End-to-end perimeter integration test.
 *
 * Wires the REAL gateway proxy core (`handleGatewayRequest`) to a REAL sub-app
 * built with the REAL SDK (`everyApp` from @every-app/sdk/server) over an
 * in-process service binding. The gateway mints identity JWTs the SDK verifies,
 * so this exercises the full trust contract — not stubs on either side.
 *
 * Asserts the perimeter guarantees from the task spec:
 *  (a) a logged-in request reaches the app with a verified identity
 *  (b) a request straight to the app worker (no gateway) yields 401
 *  (c) a declared public route works unauthenticated; everything else 401s
 *  (d) /__everyapp/* is unreachable unauthenticated from outside
 *  (e) Cookie and a spoofed x-everyapp-identity are stripped/replaced
 */
import { describe, it, expect, beforeAll } from "vitest";
import { everyApp } from "@every-app/sdk/server";
import { handleGatewayRequest, type GatewayDeps } from "../gateway";
import { InMemoryAppRegistry, type RegisteredApp } from "../registry";
import type { ParsedHost } from "../host";
import type { AuthenticatedSession, SessionAuthenticator } from "../session";
import { validateManifest } from "../manifest/manifest";
import { generateTestKeyPair, type TestKeyPair } from "../test-helpers";
import { IDENTITY_HEADER } from "../headers";

let keys: TestKeyPair;
const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

/** The fixture sub-app: a real worker guarded by the real SDK wrapper. */
function buildFixtureApp(publicKeys: string[]) {
  return everyApp(
    async (request, _env, _ctx, user) => {
      const url = new URL(request.url);
      if (url.pathname === "/__everyapp/ping") {
        // Reachable only with a valid identity (MCP-style internal route).
        return Response.json({ internal: true, actor: user?.actor.sub });
      }
      if (url.pathname === "/health") {
        return Response.json({ public: true, user: user?.id ?? null });
      }
      return Response.json({
        userId: user?.id ?? null,
        email: user?.email ?? null,
        sawCookie: request.headers.get("cookie"),
        sawRawIdentity: request.headers.get("x-everyapp-anything"),
      });
    },
    { id: "todo" },
    // Real deployments inject the issuer (EVERYAPP_IDENTITY_ISSUER); mirror
    // that here so identity verification matches production and the gateway's
    // minting issuer below.
    { publicKeys, issuer: "https://home.example.com" },
  );
}

const SESSION: AuthenticatedSession = {
  sub: "user_1",
  email: "user1@example.com",
  orgId: "org_1",
  orgRole: "member",
};

const TODO: RegisteredApp = {
  appId: "todo",
  hostname: "todo.example.com",
  workerName: "every-todo-app",
  tier: "service_binding",
  organizationId: "org_1",
  status: "active",
  manifest: validateManifest({ id: "todo", public: [{ path: "/health" }] }),
};

let deps: GatewayDeps;

beforeAll(async () => {
  keys = await generateTestKeyPair();
  const fixtureApp = buildFixtureApp([keys.publicKeyPem]);

  // Cookie-based session stub: `everyapp_session=user_1` ⇒ authenticated.
  const authenticator: SessionAuthenticator = {
    authenticate: async (req) =>
      (req.headers.get("cookie") ?? "").includes("everyapp_session=user_1")
        ? SESSION
        : null,
    hasAppAccess: async () => true,
  };

  deps = {
    env: { "APP__every-todo-app": fixtureApp },
    registry: new InMemoryAppRegistry([TODO]),
    authenticator,
    privateKeyPem: keys.privateKeyPem,
    issuer: "https://home.example.com",
    resolveApp: async (h: ParsedHost, reg) => reg.findByHostname(h.host),
  };
});

function gwReq(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "todo.example.com");
  return new Request(`https://todo.example.com${path}`, { ...init, headers });
}
const LOGGED_IN = { cookie: "everyapp_session=user_1" };

describe("perimeter end-to-end (gateway + real SDK app)", () => {
  it("(a) a logged-in request reaches the app with a verified identity", async () => {
    const res = await handleGatewayRequest(
      gwReq("/tasks", { headers: LOGGED_IN }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; email: string };
    // The app only ever sees a verified user — proving mint→verify works.
    expect(body.userId).toBe("user_1");
    expect(body.email).toBe("user1@example.com");
  });

  it("(b) a request straight to the app worker (no gateway) yields 401", async () => {
    const app = buildFixtureApp([keys.publicKeyPem]);
    const res = await app.fetch(
      new Request("https://todo.example.com/tasks"),
      {},
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("(c) a declared public route works unauthenticated", async () => {
    const res = await handleGatewayRequest(gwReq("/health"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { public: boolean; user: string | null };
    expect(body.public).toBe(true);
    expect(body.user).toBeNull();
  });

  it("(c3) a spoofed public header straight at the worker yields 401", async () => {
    // The bypass a bare-flag marker would allow: a re-exposed app worker
    // receiving a client-forged x-everyapp-public. Must fail closed.
    const app = buildFixtureApp([keys.publicKeyPem]);
    for (const path of ["/tasks", "/health", "/__everyapp/ping"]) {
      const res = await app.fetch(
        new Request(`https://todo.example.com${path}`, {
          headers: { "x-everyapp-public": "1" },
        }),
        {},
        ctx,
      );
      expect(res.status).toBe(401);
    }
  });

  it("(c2) a non-public route 401s when unauthenticated", async () => {
    const res = await handleGatewayRequest(gwReq("/tasks"), deps);
    expect(res.status).toBe(401);
  });

  it("(d) /__everyapp/* is unreachable unauthenticated from outside", async () => {
    const res = await handleGatewayRequest(
      gwReq("/__everyapp/ping", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      deps,
    );
    expect(res.status).toBe(401);
  });

  it("(d2) /__everyapp/* IS reachable with a valid identity (MCP path)", async () => {
    const res = await handleGatewayRequest(
      gwReq("/__everyapp/ping", {
        method: "POST",
        headers: { ...LOGGED_IN, "sec-fetch-site": "same-origin" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { internal: boolean }).internal).toBe(true);
  });

  it("(e) Cookie and a spoofed x-everyapp-* header are stripped before the app", async () => {
    const res = await handleGatewayRequest(
      gwReq("/tasks", {
        headers: {
          ...LOGGED_IN,
          [IDENTITY_HEADER]: "spoofed.jwt.value",
          "x-everyapp-anything": "evil",
        },
      }),
      deps,
    );
    const body = (await res.json()) as {
      userId: string;
      sawCookie: string | null;
      sawRawIdentity: string | null;
    };
    // App still authenticates (gateway minted a real identity) ...
    expect(body.userId).toBe("user_1");
    // ... but never saw the user's cookie or the forged headers.
    expect(body.sawCookie).toBeNull();
    expect(body.sawRawIdentity).toBeNull();
  });
});
