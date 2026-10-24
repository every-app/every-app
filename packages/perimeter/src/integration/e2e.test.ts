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
 *  (f) a token minted for one Worker is refused by another Worker of the
 *      same app id (another organization's copy)
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
// TODO(integration): PR 2 types everyApp()'s ctx as the runtime ExecutionContext.
const ctx = {
  waitUntil: (_promise: Promise<unknown>) => {},
} as unknown as ExecutionContext;

/** A Worker's env as everyAppWorker() deploys it: its name is the audience. */
function workerEnv(workerName: string) {
  return { EVERYAPP_AUDIENCE: workerName };
}

/** The service binding to a deployed fixture app Worker. */
function binding(
  app: ReturnType<typeof buildFixtureApp>,
  workerName: string,
  seen: string[] = [],
) {
  return {
    fetch: (request: Request) => {
      seen.push(request.headers.get(IDENTITY_HEADER) ?? "");
      return app.fetch(request, workerEnv(workerName), ctx);
    },
  };
}

/** What the fixture's handshake carries: Node has no WebSocketPair. */
const SOCKET = { accept: () => undefined };

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
      if (url.pathname === "/ws") {
        // A Worker answers an upgrade with a 101 carrying its WebSocket.
        // Node's Response constructor rejects status 101 and has no
        // WebSocketPair, so shadow both (as gateway.test.ts does). A 101 has
        // no body: the handshake's headers echo what the app saw.
        const handshake = new Response(null, {
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "x-fixture-user": user?.id ?? "none",
            "x-fixture-cookie": request.headers.get("cookie") ?? "none",
          },
        });
        Object.defineProperty(handshake, "status", { value: 101 });
        Object.defineProperty(handshake, "webSocket", { value: SOCKET });
        return handshake;
      }
      return Response.json({
        userId: user?.id ?? null,
        email: user?.email ?? null,
        sawCookie: request.headers.get("cookie"),
        sawRawIdentity: request.headers.get("x-everyapp-anything"),
        sawOrg: request.headers.get("x-everyapp-org"),
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
  scope: "org",
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
    sessionCookieNames: ["everyapp_session"],
    authenticate: async (req) =>
      (req.headers.get("cookie") ?? "").includes("everyapp_session=user_1")
        ? SESSION
        : null,
    hasAppAccess: async () => true,
  };

  deps = {
    env: { "APP__every-todo-app": binding(fixtureApp, TODO.workerName) },
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
      workerEnv(TODO.workerName),
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
        workerEnv(TODO.workerName),
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

  it("(d3) the internal tools contract is 404 from outside, even signed in", async () => {
    for (const path of [
      "/__everyapp/tools/list",
      "/__everyapp/tools/call",
      "/p/%2e%2e/__everyapp/tools/call",
      "/__everyapp%2ftools%2fcall",
    ]) {
      const res = await handleGatewayRequest(
        gwReq(path, {
          method: "POST",
          headers: { ...LOGGED_IN, "sec-fetch-site": "same-origin" },
        }),
        deps,
      );
      expect(res.status, path).toBe(404);
    }
  });

  it("(e) Cookie and a spoofed x-everyapp-* header are stripped before the app", async () => {
    const res = await handleGatewayRequest(
      gwReq("/tasks", {
        headers: {
          ...LOGGED_IN,
          [IDENTITY_HEADER]: "spoofed.jwt.value",
          "x-everyapp-anything": "evil",
          // What a shared app's background work names: never a browser.
          "x-everyapp-org": "org_victim",
        },
      }),
      deps,
    );
    const body = (await res.json()) as {
      userId: string;
      sawCookie: string | null;
      sawRawIdentity: string | null;
      sawOrg: string | null;
    };
    // App still authenticates (gateway minted a real identity) ...
    expect(body.userId).toBe("user_1");
    // ... but never saw the user's cookie or the forged headers.
    expect(body.sawCookie).toBeNull();
    expect(body.sawRawIdentity).toBeNull();
    expect(body.sawOrg).toBeNull();
  });

  it("(f) a token minted for one Worker is refused by another Worker of the same app id", async () => {
    // Two organizations' copies of `todo`, each its own Worker.
    const BETA_TODO: RegisteredApp = {
      ...TODO,
      hostname: "todo-beta.example.com",
      workerName: "every-beta-todo",
      organizationId: "org_2",
    };
    const minted: string[] = [];
    const alpha = binding(
      buildFixtureApp([keys.publicKeyPem]),
      TODO.workerName,
      minted,
    );
    const beta = buildFixtureApp([keys.publicKeyPem]);
    const twoApps: GatewayDeps = {
      ...deps,
      env: {
        "APP__every-todo-app": alpha,
        "APP__every-beta-todo": binding(beta, BETA_TODO.workerName),
      },
      registry: new InMemoryAppRegistry([TODO, BETA_TODO]),
    };

    const own = await handleGatewayRequest(
      gwReq("/tasks", { headers: LOGGED_IN }),
      twoApps,
    );
    expect(own.status).toBe(200);
    const tokenForAlpha = minted.at(-1);
    expect(tokenForAlpha).toBeTruthy();

    // Replayed at the other Worker (same app id, same keys, same issuer).
    const replayed = await beta.fetch(
      new Request("https://todo-beta.example.com/tasks", {
        headers: { [IDENTITY_HEADER]: tokenForAlpha! },
      }),
      workerEnv(BETA_TODO.workerName),
      ctx,
    );
    expect(replayed.status).toBe(401);
  });
});

describe("perimeter end-to-end: cookie tossing", () => {
  const SESSION_COOKIE = "everyapp_session";
  const SESSIONS: Record<string, AuthenticatedSession> = {
    user_1: SESSION,
    attacker: {
      sub: "attacker",
      email: "attacker@example.com",
      orgId: "org_1",
      orgRole: "member",
    },
  };
  let authenticateCalls = 0;

  /**
   * Reads the session the way a cookie parser that keeps the last copy does
   * (Better Auth's): whichever copy the browser sends last wins.
   */
  function tossingDeps(): GatewayDeps {
    const authenticator: SessionAuthenticator = {
      sessionCookieNames: [SESSION_COOKIE, `__Secure-${SESSION_COOKIE}`],
      authenticate: async (req) => {
        authenticateCalls++;
        let token: string | undefined;
        for (const pair of (req.headers.get("cookie") ?? "").split(";")) {
          const [name, value] = pair.trim().split("=");
          if (name?.endsWith(SESSION_COOKIE)) token = value;
        }
        return token ? (SESSIONS[token] ?? null) : null;
      },
      hasAppAccess: async () => true,
    };
    return { ...deps, authenticator };
  }

  it("a single session cookie still reaches the app as its member", async () => {
    authenticateCalls = 0;
    const res = await handleGatewayRequest(
      gwReq("/tasks", {
        headers: { cookie: `theme=dark; __Secure-${SESSION_COOKIE}=user_1` },
      }),
      tossingDeps(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId: string }).userId).toBe("user_1");
    expect(authenticateCalls).toBe(1);
  });

  it("refuses a copy a sibling subdomain planted, before authenticating", async () => {
    // evil.example.com set `everyapp_session=attacker; Domain=example.com;
    // Path=/tasks`: the browser sends it to todo.example.com beside the
    // member's own cookie, the longer path first.
    authenticateCalls = 0;
    const res = await handleGatewayRequest(
      gwReq("/tasks", {
        headers: {
          cookie: `${SESSION_COOKIE}=attacker; ${SESSION_COOKIE}=user_1`,
        },
      }),
      tossingDeps(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthenticated",
      reason: "duplicate_session_cookie",
      // The planted copy stays until the person clears it: say so.
      message: expect.stringContaining(
        "Clear this site's cookies and sign in again.",
      ),
    });
    expect(authenticateCalls).toBe(0);
  });

  it("refuses it in any order, with or without the __Secure- prefix, on public routes too", async () => {
    for (const [path, cookie] of [
      ["/tasks", `${SESSION_COOKIE}=user_1; ${SESSION_COOKIE}=attacker`],
      [
        "/tasks",
        `__Secure-${SESSION_COOKIE}=user_1; theme=dark; ${SESSION_COOKIE}=attacker`,
      ],
      ["/health", `${SESSION_COOKIE}=attacker; ${SESSION_COOKIE}=user_1`],
    ] as const) {
      authenticateCalls = 0;
      const res = await handleGatewayRequest(
        gwReq(path, { headers: { cookie } }),
        tossingDeps(),
      );
      expect(res.status, cookie).toBe(401);
      expect(authenticateCalls).toBe(0);
    }
  });

  it("won't take an authenticator that leaves out its session cookie names", () => {
    // Optional, a forgotten field would quietly skip the refusal above.
    const forgetful = {
      authenticate: async () => SESSION,
      hasAppAccess: async () => true,
    };
    // @ts-expect-error sessionCookieNames is required
    const authenticator: SessionAuthenticator = forgetful;
    expect(authenticator).toBe(forgetful);
  });
});

describe("perimeter end-to-end: WebSocket upgrade", () => {
  /** The gateway in front of a fresh fixture Worker, recording what it saw. */
  function wsDeps(seen: string[]): GatewayDeps {
    return {
      ...deps,
      env: {
        "APP__every-todo-app": binding(
          buildFixtureApp([keys.publicKeyPem]),
          TODO.workerName,
          seen,
        ),
      },
    };
  }
  function upgrade(headers: Record<string, string>): Request {
    return gwReq("/ws", { headers: { upgrade: "websocket", ...headers } });
  }

  it("a signed-in same-origin upgrade reaches the app and its 101 comes back untouched", async () => {
    const res = await handleGatewayRequest(
      upgrade({ ...LOGGED_IN, origin: "https://todo.example.com" }),
      wsDeps([]),
    );
    expect(res.status).toBe(101);
    expect(res.headers.get("upgrade")).toBe("websocket");
    // The app saw a verified member ...
    expect(res.headers.get("x-fixture-user")).toBe("user_1");
    // ... and its handshake came back as is: same socket, no page headers.
    expect(res.webSocket).toBe(SOCKET);
    expect(res.headers.get("x-content-type-options")).toBeNull();
  });

  it("refuses an upgrade from a foreign Origin before the app sees it", async () => {
    const seen: string[] = [];
    const res = await handleGatewayRequest(
      upgrade({ ...LOGGED_IN, origin: "https://evil.example.net" }),
      wsDeps(seen),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "csrf_denied" });
    expect(seen).toEqual([]);
  });

  it("forwards the upgrade with a minted identity and without the cookie", async () => {
    const seen: string[] = [];
    const res = await handleGatewayRequest(
      upgrade({
        ...LOGGED_IN,
        origin: "https://todo.example.com",
        [IDENTITY_HEADER]: "spoofed.jwt.value",
      }),
      wsDeps(seen),
    );
    expect(res.status).toBe(101);
    // The app Worker received a gateway-minted x-everyapp-identity, not the
    // spoofed one, and no cookie: an upgrade is proxied like any request.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeTruthy();
    expect(seen[0]).not.toBe("spoofed.jwt.value");
    expect(res.headers.get("x-fixture-user")).toBe("user_1");
    expect(res.headers.get("x-fixture-cookie")).toBe("none");
  });
});
