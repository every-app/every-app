import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  UnroutableAppError,
  type AppRegistry,
  type RegisteredApp,
} from "@every-app/perimeter";
import server, {
  clearHostnameCacheForTests,
  resolveAppByHostname,
} from "./server";
import { resetHealthForTests } from "./server/health";
import { validateManifest } from "@every-app/perimeter/manifest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  hasAnyActiveApp: vi.fn(),
  findByHostname: vi.fn(),
  authenticate: vi.fn(),
  controlPlaneFetch: vi.fn(),
  serveAppHostMcp: vi.fn(),
  runMcpMaintenance: vi.fn(),
  sweep: vi.fn(),
  activateApp: vi.fn(),
  activateDeployingApps: vi.fn(),
  followAppVersion: vi.fn(),
  refuseUnreadyApp: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mocks.env,
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: mocks.controlPlaneFetch },
}));

vi.mock("./server/mcp-auth/maintenance", () => ({
  runMcpMaintenance: mocks.runMcpMaintenance,
}));

vi.mock("./server/events/deliver", () => ({
  sweep: mocks.sweep,
}));

vi.mock("./perimeter/drizzleAppRegistry", () => ({
  DrizzleAppRegistry: class {
    hasAnyActiveApp = mocks.hasAnyActiveApp;
    findByHostname = mocks.findByHostname;
  },
}));

vi.mock("./server/toolbus/app-host-mcp", () => ({
  serveAppHostMcp: mocks.serveAppHostMcp,
}));

vi.mock("./server/app-activation", () => ({
  activateApp: mocks.activateApp,
  activateDeployingApps: mocks.activateDeployingApps,
  followAppVersion: mocks.followAppVersion,
}));

// The gate itself is covered by server/app-needs-setup.test.ts; here it is
// a stand-in, so what is pinned is that server.ts wires it.
vi.mock("./server/app-needs-setup", () => ({
  refuseUnreadyApp: mocks.refuseUnreadyApp,
}));

vi.mock("./perimeter/betterAuthAuthenticator", () => ({
  createProdAuthenticator: () => ({
    sessionCookieNames: [],
    authenticate: mocks.authenticate,
    hasAppAccess: vi.fn(async () => true),
  }),
}));

const TODO: RegisteredApp = {
  appId: "todo",
  hostname: "todo.example.com",
  workerName: "every-todo",
  tier: "service_binding",
  scope: "org",
  organizationId: "org-1",
  status: "active",
  manifest: validateManifest({ id: "todo" }),
};

/** The same app, its manifest asking the gateway to serve /mcp on its host. */
const TODO_MCP: RegisteredApp = {
  ...TODO,
  manifest: validateManifest({
    id: "todo",
    mcp: { by: "gateway", why: "Scripts drive this app alone." },
  }),
};

/** A signing key for the tests that proxy to an app (the identity is minted). */
function realSigningKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

function registryReturning(app: RegisteredApp | null): AppRegistry & {
  findByHostname: ReturnType<typeof vi.fn>;
} {
  return {
    hasAnyActiveApp: vi.fn(async () => app?.status === "active"),
    findByHostname: vi.fn(async () => app),
    findByAppId: vi.fn(async () => app),
    findByOrgApp: vi.fn(async () => app),
  };
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("strict-transport-security")).toBe(
    "max-age=63072000; includeSubDomains; preload",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hostname app cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    clearHostnameCacheForTests();
  });

  it("caches hostname hits for 30 seconds", async () => {
    const registry = registryReturning(TODO);

    await expect(
      resolveAppByHostname(registry, "todo.example.com"),
    ).resolves.toBe(TODO);
    await expect(
      resolveAppByHostname(registry, "todo.example.com"),
    ).resolves.toBe(TODO);
    expect(registry.findByHostname).toHaveBeenCalledTimes(1);

    vi.setSystemTime(30_001);
    await resolveAppByHostname(registry, "todo.example.com");
    expect(registry.findByHostname).toHaveBeenCalledTimes(2);
  });

  it("caches hostname misses for 5 seconds", async () => {
    const registry = registryReturning(null);

    await expect(
      resolveAppByHostname(registry, "missing.example.com"),
    ).resolves.toBeNull();
    await expect(
      resolveAppByHostname(registry, "missing.example.com"),
    ).resolves.toBeNull();
    expect(registry.findByHostname).toHaveBeenCalledTimes(1);

    vi.setSystemTime(5_001);
    await resolveAppByHostname(registry, "missing.example.com");
    expect(registry.findByHostname).toHaveBeenCalledTimes(2);
  });
});

describe("gateway-generated errors", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearHostnameCacheForTests();
    mocks.hasAnyActiveApp.mockReset();
    mocks.findByHostname.mockReset();
    mocks.authenticate.mockReset();
    mocks.controlPlaneFetch.mockReset();
    mocks.controlPlaneFetch.mockResolvedValue(new Response("control plane"));
    for (const key of Object.keys(mocks.env)) delete mocks.env[key];
    Object.assign(mocks.env, {
      DB: {},
      GATEWAY_URL: "https://example.com",
      JWT_PRIVATE_KEY: "unused in these tests",
    });
  });

  it("serves the control plane without GATEWAY_URL when the registry is empty", async () => {
    delete mocks.env.GATEWAY_URL;
    mocks.hasAnyActiveApp.mockResolvedValue(false);

    const request = new Request("https://fresh.example.com/", {
      headers: { host: "fresh.example.com" },
    });
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("control plane");
    expect(mocks.hasAnyActiveApp).toHaveBeenCalledOnce();
    expect(mocks.controlPlaneFetch).toHaveBeenCalledWith(request);
  });

  it("serves the control plane when the registry query throws (unmigrated build-time DB)", async () => {
    delete mocks.env.GATEWAY_URL;
    mocks.hasAnyActiveApp.mockRejectedValue(new Error("no such table: apps"));

    const request = new Request("https://fresh.example.com/", {
      headers: { host: "fresh.example.com" },
    });
    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("control plane");
  });

  it("fails closed without GATEWAY_URL when an active app is registered", async () => {
    delete mocks.env.GATEWAY_URL;
    mocks.hasAnyActiveApp.mockResolvedValue(true);

    const response = await server.fetch(
      new Request("https://todo.example.com/", {
        headers: { host: "todo.example.com" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "gateway_misconfigured",
    });
    expectSecurityHeaders(response);
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("stamps security headers on an unknown app host 404", async () => {
    mocks.findByHostname.mockResolvedValue(null);

    const response = await server.fetch(
      new Request("https://missing.example.com/", {
        headers: { host: "missing.example.com" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_app_host" });
    expectSecurityHeaders(response);
  });

  it("serves registered app hosts below APP_BASE_DOMAIN and 404s the rest there", async () => {
    vi.stubEnv("DEV", false);
    mocks.env["APP_BASE_DOMAIN"] = "apps.example.net";
    try {
      mocks.findByHostname.mockResolvedValue(null);
      const response = await server.fetch(
        new Request("https://missing.apps.example.net/", {
          headers: { host: "missing.apps.example.net" },
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "unknown_app_host" });
      expectSecurityHeaders(response);
      expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
    } finally {
      delete mocks.env["APP_BASE_DOMAIN"];
      vi.unstubAllEnvs();
    }
  });

  it("answers 503 on the host of a registry row it can't route", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.findByHostname.mockRejectedValue(
      new UnroutableAppError("todo", 'unknown tier "worker_loader"'),
    );

    const response = await server.fetch(
      new Request("https://todo.example.com/", {
        headers: { host: "todo.example.com" },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "app_unavailable",
      app: "todo",
    });
    expectSecurityHeaders(response);
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("treats a failed app lookup as no app and never serves app content", async () => {
    mocks.findByHostname.mockRejectedValue(new Error("no such table: apps"));

    const wildcardResponse = await server.fetch(
      new Request("https://missing.example.com/", {
        headers: { host: "missing.example.com" },
      }),
    );
    expect(wildcardResponse.status).toBe(404);
    expect(await wildcardResponse.json()).toEqual({
      error: "unknown_app_host",
    });

    // Local dev serves the control plane on other hosts (mirror mode calls
    // the gateway on localhost); it never serves app content there.
    const unrelatedResponse = await server.fetch(
      new Request("https://localhost:3000/", {
        headers: { host: "localhost:3000" },
      }),
    );
    expect(unrelatedResponse.status).toBe(200);
    expect(await unrelatedResponse.text()).toBe("control plane");
  });

  it("answers any host but its own with 404 in a deployed gateway", async () => {
    vi.stubEnv("DEV", false);
    try {
      mocks.findByHostname.mockResolvedValue(null);
      for (const host of [
        "every-app-gateway.acme.workers.dev",
        "alias.example.net",
        "localhost:3000",
      ]) {
        const response = await server.fetch(
          new Request(`https://${host}/sign-in`, { headers: { host } }),
        );
        expect(response.status, host).toBe(404);
        expect(await response.json()).toEqual({ error: "unknown_host" });
        expectSecurityHeaders(response);
      }
      expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();

      const own = await server.fetch(
        new Request("https://example.com/sign-in", {
          headers: { host: "example.com" },
        }),
      );
      expect(own.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stamps security headers on a perimeter-error 502", async () => {
    mocks.findByHostname.mockResolvedValue(TODO);
    mocks.authenticate.mockRejectedValue(new Error("authentication failed"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await server.fetch(
      new Request("https://todo.example.com/", {
        headers: { host: "todo.example.com" },
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_error" });
    expectSecurityHeaders(response);
    consoleError.mockRestore();
  });
});

describe("gateway host (control plane)", () => {
  beforeEach(() => {
    clearHostnameCacheForTests();
    mocks.controlPlaneFetch.mockReset();
    mocks.controlPlaneFetch.mockResolvedValue(
      new Response("<html></html>", {
        headers: {
          "content-type": "text/html",
          "set-cookie": "session=abc; Domain=example.com; Path=/; HttpOnly",
        },
      }),
    );
    for (const key of Object.keys(mocks.env)) delete mocks.env[key];
    Object.assign(mocks.env, {
      DB: {},
      GATEWAY_URL: "https://example.com",
      JWT_PRIVATE_KEY: "unused in these tests",
    });
  });

  function gatewayRequest(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("host", "example.com");
    return new Request(`https://example.com${path}`, { ...init, headers });
  }

  it("stamps control-plane security headers and keeps the session cookie domain", async () => {
    const response = await server.fetch(gatewayRequest("/"));

    expect(response.status).toBe(200);
    // The gateway host is often the customer's apex: HSTS covers it alone.
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=63072000",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([
      "session=abc; Domain=example.com; Path=/; HttpOnly",
    ]);
  });

  it("refuses a session cookie tossed in by a sibling subdomain, before anything runs", async () => {
    // evil.example.com set `__Secure-better-auth.session_token=<its own>;
    // Domain=example.com; Path=/api`: the browser sends both copies here.
    for (const cookie of [
      "__Secure-better-auth.session_token=tossed.sig; __Secure-better-auth.session_token=mine.sig",
      "__Secure-better-auth.session_token=mine.sig; theme=dark; better-auth.session_token=tossed.sig",
    ]) {
      const response = await server.fetch(
        gatewayRequest("/api/auth/get-session", { headers: { cookie } }),
      );
      expect(response.status, cookie).toBe(401);
      expect(await response.json()).toMatchObject({
        error: "duplicate_session_cookie",
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();

    const single = await server.fetch(
      gatewayRequest("/api/auth/get-session", {
        headers: { cookie: "__Secure-better-auth.session_token=mine.sig" },
      }),
    );
    expect(single.status).toBe(200);
    expect(mocks.controlPlaneFetch).toHaveBeenCalledOnce();
  });

  it("logs a tossed session cookie on the gateway host with where, never the cookie", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await server.fetch(
        gatewayRequest("/api/auth/get-session?x=1", {
          headers: {
            cookie:
              "__Secure-better-auth.session_token=tossed.sig; __Secure-better-auth.session_token=mine.sig",
          },
        }),
      );
      expect(response.status).toBe(401);
      expect(warn).toHaveBeenCalledOnce();
      const line = String(warn.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toEqual({
        evt: "session.duplicate_cookie",
        host: "example.com",
        path: "/api/auth/get-session",
      });
      expect(line).not.toContain("sig");
    } finally {
      warn.mockRestore();
    }
  });

  it("never caches admin, consent or setup pages", async () => {
    for (const path of [
      "/admin",
      "/admin/users",
      "/oauth/consent?handle=x",
      "/setup",
    ]) {
      const response = await server.fetch(gatewayRequest(path));
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("rejects a server-function GET reached by navigation", async () => {
    const response = await server.fetch(
      gatewayRequest("/_serverFn/abc?createServerFn&payload=%7B%7D", {
        headers: {
          cookie: "session=abc",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "server_fn_denied" });
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects cross-site and sibling-app server-function calls", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const response = await server.fetch(
        gatewayRequest("/_serverFn/abc", {
          method: "POST",
          headers: {
            cookie: "session=abc",
            "sec-fetch-site": site,
            "x-tsr-serverfn": "true",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
    }
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("guards a server-function path whose other escapes are malformed", async () => {
    const response = await server.fetch(
      gatewayRequest("/%5FserverFn/abc/%ZZ", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          "sec-fetch-site": "same-site",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "server_fn_denied" });
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("serves same-origin server-function calls", async () => {
    const response = await server.fetch(
      gatewayRequest("/_serverFn/abc", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          origin: "https://example.com",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "x-tsr-serverfn": "true",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.controlPlaneFetch).toHaveBeenCalledOnce();
  });

  it("rejects a cookie-carrying cross-site POST to any control-plane route", async () => {
    const response = await server.fetch(
      gatewayRequest("/api/auth/organization/invite-member", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          origin: "https://evil.example.net",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "csrf_denied" });
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("lets token-authenticated routes and cookieless POSTs through", async () => {
    const oauthToken = await server.fetch(
      gatewayRequest("/oauth/token", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=refresh_token",
      }),
    );
    expect(oauthToken.status).not.toBe(403);

    const cookielessPost = await server.fetch(
      gatewayRequest("/api/setup/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(cookielessPost.status).toBe(200);
  });

  it("lets Apple's cross-site callback POST through to Better Auth, which only redirects it", async () => {
    // Sign in with Apple returns with `response_mode=form_post` from
    // appleid.apple.com; cookies another site set for the domain (Access's)
    // may ride along. Better Auth answers the POST with a redirect to the
    // same URL as a GET, reading no cookie and creating nothing, so the
    // POST is exempt from the Origin check (and from Access's login).
    const applePost = await server.fetch(
      gatewayRequest("/api/auth/callback/apple", {
        method: "POST",
        headers: {
          cookie: "CF_Authorization=abc",
          origin: "https://appleid.apple.com",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "code=c&state=s",
      }),
    );
    expect(applePost.status).not.toBe(403);
    expect(mocks.controlPlaneFetch).toHaveBeenCalledTimes(1);

    // Only that path, and only its POST: another provider's callback, or
    // any other Better Auth POST, is checked as before.
    mocks.controlPlaneFetch.mockClear();
    const googlePost = await server.fetch(
      gatewayRequest("/api/auth/callback/google", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          origin: "https://accounts.google.com",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "code=c&state=s",
      }),
    );
    expect(googlePost.status).toBe(403);
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("exempts no deploy API or deploy-token route from the cookie check: there are none", async () => {
    for (const path of ["/api/deploy/register", "/api/setup/deploy-token"]) {
      const response = await server.fetch(
        gatewayRequest(path, {
          method: "POST",
          headers: {
            cookie: "session=abc",
            authorization: "Bearer eak_x",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
    }
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("exempts no cookie POST from the Origin / Sec-Fetch-Site check, Better Auth's routes included", async () => {
    const post = (path: string, headers: Record<string, string>) =>
      server.fetch(
        gatewayRequest(path, {
          method: "POST",
          headers: {
            cookie: "session=abc",
            "content-type": "application/json",
            ...headers,
          },
          body: "{}",
        }),
      );

    const denied: [string, Record<string, string>][] = [
      // A cookie POST with neither Origin nor Sec-Fetch-Site: no native
      // client is exempt any more.
      ["/api/auth/sign-in/email", {}],
      ["/api/auth/sign-out", {}],
      ["/api/setup/claim", {}],
      ["/_serverFn/abc", { "x-tsr-serverfn": "true" }],
      // A custom-scheme Origin is never the gateway's host.
      ["/api/auth/sign-in/email", { origin: "app://shell" }],
      ["/api/auth/sign-out", { origin: "app://shell" }],
      // A browser always sends Fetch Metadata: same-site is a sibling app.
      [
        "/api/auth/sign-out",
        { origin: "https://todo.example.com", "sec-fetch-site": "same-site" },
      ],
    ];
    for (const [path, headers] of denied) {
      const response = await post(path, headers);
      expect(response.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
    }
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rate-limits credential requests before they reach the control plane", async () => {
    const keys: string[] = [];
    mocks.env.AUTH_RATE_LIMIT_IP = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    };
    const signIn = () =>
      server.fetch(
        gatewayRequest("/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            origin: "https://example.com",
            "cf-connecting-ip": "203.0.113.7",
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: "owner@example.com" }),
        }),
      );

    const response = await signIn();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(keys).toEqual(["ip:203.0.113.7"]);
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();

    // Pages and other routes are never counted.
    expect((await server.fetch(gatewayRequest("/sign-in"))).status).toBe(200);
    expect(keys).toHaveLength(1);
  });

  it("returns 404 for every OAuth endpoint while MCP_OAUTH_ENABLED is false", async () => {
    mocks.env.MCP_OAUTH_ENABLED = "false";
    for (const [method, path] of [
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", "/.well-known/openid-configuration"],
      ["POST", "/oauth/register"],
      ["GET", "/oauth/authorize?client_id=x"],
      ["GET", "/oauth/consent?handle=x"],
      ["POST", "/oauth/consent/decision"],
      ["POST", "/oauth/token"],
    ] as const) {
      const response = await server.fetch(gatewayRequest(path, { method }));
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: "oauth_disabled" });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();

    // /mcp still takes personal tokens, with a challenge that names no
    // authorization server.
    const challenge = await server.fetch(
      gatewayRequest("/mcp", { method: "POST", body: "{}" }),
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app"',
    );
  });

  it("serves the OAuth discovery documents when MCP_OAUTH_ENABLED is unset", async () => {
    const metadata = await server.fetch(
      gatewayRequest("/.well-known/oauth-authorization-server"),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: "https://example.com",
      authorization_endpoint: "https://example.com/oauth/authorize",
    });
    // Security headers are stamped on the library's answers too.
    expect(metadata.headers.get("x-frame-options")).toBe("DENY");

    const challenge = await server.fetch(
      gatewayRequest("/mcp", { method: "POST", body: "{}" }),
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("serves no aliases under /mcp, and leaves look-alikes to the control plane", async () => {
    for (const path of ["/mcp/", "/mcp/apps/todo", "/mcp/x"]) {
      const response = await server.fetch(
        gatewayRequest(path, { method: "POST", body: "{}" }),
      );
      expect(response.status, path).toBe(404);
    }
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();

    await server.fetch(gatewayRequest("/mcp-admin"));
    expect(mocks.controlPlaneFetch).toHaveBeenCalledOnce();
  });

  it("answers a JSON 404, never the control plane, on every spelling of a bypassed prefix it doesn't serve", async () => {
    // Cloudflare Access matches its bypass paths case-insensitively and
    // `/.well-known/*` spans the whole prefix; the MCP/OAuth router matches
    // exact lower-case paths. What Access lets through and the router
    // doesn't claim must not reach the control plane's shell.
    for (const [method, path] of [
      ["GET", "/HEALTH"],
      ["GET", "/Health"],
      ["POST", "/HEALTH"],
      ["GET", "/MCP"],
      ["POST", "/MCP"],
      ["GET", "/Mcp"],
      ["GET", "/MCP/api/auth/get-session"],
      ["GET", "/OAUTH/TOKEN"],
      ["POST", "/OAUTH/REGISTER"],
      ["GET", "/.WELL-KNOWN/x"],
      ["GET", "/.WELL-KNOWN/oauth-authorization-server"],
      ["GET", "/.well-known/foo"],
      ["GET", "/.well-known/jwks.json"],
      ["POST", "/API/AUTH/CALLBACK/APPLE"],
      ["GET", "/Api/Auth/Callback/Apple"],
    ] as const) {
      const response = await server.fetch(
        gatewayRequest(path, {
          method,
          body: method === "POST" ? "{}" : undefined,
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("content-type"), path).toContain(
        "application/json",
      );
      expect(await response.json(), path).toEqual({ error: "not_found" });
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("x-content-type-options"), path).toBe(
        "nosniff",
      );
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("strict-transport-security"), path).toBe(
        "max-age=63072000",
      );
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
    }
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();

    // The lower-case paths answer as before: the router's own replies.
    const mcp = await server.fetch(
      gatewayRequest("/mcp", { method: "POST", body: "{}" }),
    );
    expect(mcp.status).toBe(401);
    const metadata = await server.fetch(
      gatewayRequest("/.well-known/oauth-authorization-server"),
    );
    expect(metadata.status).toBe(200);
    // And the consent page, under /oauth but not bypassed, is still a page.
    await server.fetch(gatewayRequest("/oauth/consent?handle=x"));
    expect(mocks.controlPlaneFetch).toHaveBeenCalledOnce();
  });

  it("serves /health for uptime monitors: a bounded SELECT 1, no session, no version, never cached", async () => {
    resetHealthForTests();
    const first = vi.fn(async () => ({ 1: 1 }));
    mocks.env.DB = { prepare: vi.fn(() => ({ first })) };
    mocks.authenticate.mockReset();

    const get = await server.fetch(gatewayRequest("/health"));
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual({ status: "ok" });
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("content-type")).toContain("application/json");
    // Stamped like the other machine routes on this host.
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("x-frame-options")).toBe("DENY");
    expect(get.headers.get("strict-transport-security")).toBe(
      "max-age=63072000",
    );
    expect(get.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first).toHaveBeenCalledOnce();

    const head = await server.fetch(
      gatewayRequest("/health", { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");

    const post = await server.fetch(
      gatewayRequest("/health", { method: "POST", body: "{}" }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");

    // A cookie on the request changes nothing: no session is read.
    const withCookie = await server.fetch(
      gatewayRequest("/health", { headers: { cookie: "session=abc" } }),
    );
    expect(withCookie.status).toBe(200);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();

    // The database down: 503, three words, still uncached.
    resetHealthForTests();
    mocks.env.DB = {
      prepare: () => ({
        first: async () => {
          throw new Error("D1_ERROR");
        },
      }),
    };
    const down = await server.fetch(gatewayRequest("/health"));
    expect(down.status).toBe(503);
    await expect(down.json()).resolves.toEqual({
      status: "error",
      database: "down",
    });
    expect(down.headers.get("cache-control")).toBe("no-store");
    expect(mocks.controlPlaneFetch).not.toHaveBeenCalled();
    resetHealthForTests();
  });

  it("leaves /health on an app host to the app: a private route like any other", async () => {
    resetHealthForTests();
    const appFetch = vi.fn(async () => new Response("the app's own health"));
    mocks.env["APP__every-todo"] = { fetch: appFetch };
    mocks.env.JWT_PRIVATE_KEY = realSigningKey();
    const prepare = vi.fn();
    mocks.env.DB = { prepare };
    mocks.findByHostname.mockReset();
    mocks.findByHostname.mockResolvedValue(TODO);
    mocks.authenticate.mockReset();
    mocks.authenticate.mockResolvedValue(null);
    const appRequest = () =>
      new Request("https://todo.example.com/health", {
        headers: { host: "todo.example.com" },
      });

    const anonymous = await server.fetch(appRequest());
    expect(anonymous.status).toBe(401);
    expect(appFetch).not.toHaveBeenCalled();

    mocks.authenticate.mockResolvedValue({
      sub: "user-1",
      email: "user@example.com",
      orgId: "org-1",
      orgRole: "member",
    });
    const signedIn = await server.fetch(appRequest());
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).toBe("the app's own health");
    expect(appFetch).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("never reads the session cookie on /mcp, and exempts it from the cookie CSRF check", async () => {
    const response = await server.fetch(
      gatewayRequest("/mcp", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          origin: "https://evil.example.net",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    // A bearer-only endpoint: no token, no access, whatever the cookie says.
    expect(response.status).toBe(401);
  });

  it("serves an app host's /mcp from the ToolBus for a personal token, where the manifest opts in", async () => {
    mocks.findByHostname.mockResolvedValue(TODO_MCP);
    mocks.authenticate.mockResolvedValue({
      sub: "user-1",
      email: "user@example.com",
      orgId: "org-1",
      orgRole: "member",
      credential: {
        kind: "pat",
        channel: "api",
        actor: "pat:t1",
        scopes: ["*"],
      },
    });
    mocks.serveAppHostMcp.mockResolvedValue(
      Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );

    const response = await server.fetch(
      new Request("https://todo.example.com/mcp", {
        method: "POST",
        headers: {
          host: "todo.example.com",
          authorization: "Bearer epat_x",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { tools: [] } });
    expect(mocks.serveAppHostMcp).toHaveBeenCalledWith(
      expect.objectContaining({ app: TODO_MCP }),
    );
    expectSecurityHeaders(response);
    mocks.serveAppHostMcp.mockReset();

    // Without the field, the ToolBus is never asked: /mcp is the app's.
    clearHostnameCacheForTests();
    mocks.findByHostname.mockResolvedValue(TODO);
    const appFetch = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    mocks.env["APP__every-todo"] = { fetch: appFetch };
    mocks.env.JWT_PRIVATE_KEY = realSigningKey();
    const plain = await server.fetch(
      new Request("https://todo.example.com/mcp", {
        method: "POST",
        headers: {
          host: "todo.example.com",
          authorization: "Bearer epat_x",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(plain.status).toBe(404);
    expect(mocks.serveAppHostMcp).not.toHaveBeenCalled();
    expect(appFetch).toHaveBeenCalledOnce();
  });

  it("never advertises OAuth on app hosts", async () => {
    mocks.findByHostname.mockResolvedValue(TODO);

    const metadata = await server.fetch(
      new Request(
        "https://todo.example.com/.well-known/oauth-protected-resource",
        {
          headers: { host: "todo.example.com" },
        },
      ),
    );
    expect(metadata.status).toBe(404);

    mocks.authenticate.mockResolvedValue(null);
    const challenge = await server.fetch(
      new Request("https://todo.example.com/mcp", {
        method: "POST",
        headers: { host: "todo.example.com" },
      }),
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app"',
    );
  });
});

describe("activating an app on its first request", () => {
  const BINDING_TODO: RegisteredApp = {
    ...TODO,
    status: "binding",
    rowId: "row-1",
  };
  const appPage = vi.fn(async () => new Response("todo page"));

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    mocks.env.JWT_PRIVATE_KEY = privateKey;
  });

  beforeEach(() => {
    clearHostnameCacheForTests();
    for (const key of Object.keys(mocks.env)) {
      if (key !== "JWT_PRIVATE_KEY") delete mocks.env[key];
    }
    Object.assign(mocks.env, {
      DB: {},
      GATEWAY_URL: "https://example.com",
      "APP__every-todo": { fetch: appPage },
    });
    mocks.findByHostname.mockReset();
    mocks.findByHostname.mockResolvedValue(BINDING_TODO);
    mocks.activateApp.mockReset();
    mocks.followAppVersion.mockReset();
    mocks.authenticate.mockReset();
    mocks.authenticate.mockResolvedValue({
      sub: "user-1",
      email: "user@example.com",
      orgId: "org-1",
      orgRole: "member",
    });
    appPage.mockClear();
  });

  const appRequest = () =>
    server.fetch(
      new Request("https://todo.example.com/", {
        headers: { host: "todo.example.com" },
      }),
    );

  it("serves a binding app once this isolate activates it, then reads the row again", async () => {
    mocks.activateApp.mockResolvedValue(true);

    const response = await appRequest();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("todo page");
    expect(mocks.activateApp).toHaveBeenCalledWith(mocks.env, BINDING_TODO);
    // Every app-host request offers the resolved app to the version check.
    expect(mocks.followAppVersion).toHaveBeenCalledWith(BINDING_TODO);

    // The cached row said binding; the next request looks it up afresh.
    const active = { ...TODO, rowId: "row-1" };
    mocks.findByHostname.mockResolvedValue(active);
    await appRequest();
    expect(mocks.findByHostname).toHaveBeenCalledTimes(2);
    expect(mocks.activateApp).toHaveBeenCalledTimes(1);
    expect(mocks.followAppVersion).toHaveBeenLastCalledWith(active);
  });

  it("answers deploying, with Retry-After, while the binding isn't reachable", async () => {
    mocks.activateApp.mockResolvedValue(false);

    const response = await appRequest();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toEqual({
      error: "app_deploying",
      status: "binding",
    });
    expect(appPage).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it("never activates an app that isn't uploaded yet", async () => {
    mocks.findByHostname.mockResolvedValue({ ...TODO, status: "pending" });

    const response = await appRequest();
    expect(response.status).toBe(503);
    expect(mocks.activateApp).not.toHaveBeenCalled();
  });
});

describe("the setup gate on both classes of host", () => {
  const ACTIVE_TODO: RegisteredApp = { ...TODO, rowId: "row-1" };
  /** Acme's dispatch app, one label below the third-party domain. */
  const DISPATCH_TODO: RegisteredApp = {
    ...TODO,
    hostname: "todo-acme.everyapp.dev",
    workerName: "every-acme-todo",
    tier: "dispatch",
    rowId: "row-2",
  };
  const appPage = vi.fn(async () => new Response("todo page"));
  const refusal = () =>
    new Response(JSON.stringify({ error: "app_needs_setup", app: "todo" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    mocks.env.JWT_PRIVATE_KEY = privateKey;
  });

  beforeEach(() => {
    clearHostnameCacheForTests();
    for (const key of Object.keys(mocks.env)) {
      if (key !== "JWT_PRIVATE_KEY") delete mocks.env[key];
    }
    // A hosted gateway with a third-party domain serves both host classes.
    Object.assign(mocks.env, {
      DB: {},
      GATEWAY_URL: "https://example.com",
      GATEWAY_DEPLOYMENT_MODE: "hosted",
      THIRD_PARTY_DOMAIN: "everyapp.dev",
      BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
      "APP__every-todo": { fetch: appPage },
    });
    mocks.findByHostname.mockReset();
    mocks.followAppVersion.mockReset();
    mocks.authenticate.mockReset();
    mocks.authenticate.mockResolvedValue({
      sub: "user-1",
      email: "user@example.com",
      orgId: "org-1",
      orgRole: "member",
    });
    mocks.refuseUnreadyApp.mockReset();
    appPage.mockClear();
  });

  afterEach(() => {
    mocks.refuseUnreadyApp.mockReset();
  });

  const open = (host: string) =>
    server.fetch(
      new Request(`https://${host}/`, {
        headers: { host, accept: "text/html" },
      }),
    );

  it("asks the gate on a first-party host, before any credential is read", async () => {
    mocks.findByHostname.mockResolvedValue(ACTIVE_TODO);
    mocks.refuseUnreadyApp.mockResolvedValue(refusal());

    const response = await open("todo.example.com");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "app_needs_setup",
      app: "todo",
    });
    expect(mocks.refuseUnreadyApp).toHaveBeenCalledWith(
      expect.objectContaining({
        app: ACTIVE_TODO,
        request: expect.any(Request),
      }),
    );
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(appPage).not.toHaveBeenCalled();
  });

  it("asks it on a third-party host the same way", async () => {
    mocks.findByHostname.mockResolvedValue(DISPATCH_TODO);
    mocks.refuseUnreadyApp.mockResolvedValue(refusal());

    const response = await open("todo-acme.everyapp.dev");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "app_needs_setup",
      app: "todo",
    });
    expect(mocks.refuseUnreadyApp).toHaveBeenCalledWith(
      expect.objectContaining({
        app: DISPATCH_TODO,
        request: expect.any(Request),
      }),
    );
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("opens the app once the gate answers null, then authenticates", async () => {
    mocks.findByHostname.mockResolvedValue(ACTIVE_TODO);
    mocks.refuseUnreadyApp.mockResolvedValue(null);

    const response = await open("todo.example.com");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("todo page");
    expect(mocks.refuseUnreadyApp).toHaveBeenCalledOnce();
    expect(mocks.refuseUnreadyApp.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.authenticate.mock.invocationCallOrder[0]!,
    );
  });
});

describe("scheduled", () => {
  beforeEach(() => {
    mocks.sweep.mockReset().mockResolvedValue({
      due: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
    });
    mocks.runMcpMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.activateDeployingApps.mockReset().mockResolvedValue(0);
  });

  it("the hourly cron sweeps the event deliveries, then runs the MCP housekeeping with the cron's env", async () => {
    const runtimeEnv = { GATEWAY_URL: "https://example.com" };
    await server.scheduled(
      { cron: "17 * * * *" } as ScheduledController,
      runtimeEnv as unknown as Cloudflare.Env,
    );
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    expect(mocks.runMcpMaintenance).toHaveBeenCalledWith(runtimeEnv);
    expect(mocks.sweep.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runMcpMaintenance.mock.invocationCallOrder[0]!,
    );
  });

  it("a sweep that fails is logged and the hourly housekeeping still runs", async () => {
    mocks.sweep.mockRejectedValue(new Error("no such table: event_deliveries"));
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const runtimeEnv = { GATEWAY_URL: "https://example.com" };
    await expect(
      server.scheduled(
        { cron: "17 * * * *" } as ScheduledController,
        runtimeEnv as unknown as Cloudflare.Env,
      ),
    ).resolves.toBeUndefined();
    expect(mocks.runMcpMaintenance).toHaveBeenCalledWith(runtimeEnv);
    expect(
      errors.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('"evt":"events.sweep_failed"')),
    ).toHaveLength(1);
    await expect(
      server.scheduled(
        { cron: "* * * * *" } as ScheduledController,
        runtimeEnv as unknown as Cloudflare.Env,
      ),
    ).resolves.toBeUndefined();
  });

  it("the per-minute cron sweeps the event deliveries and the deploying apps, and nothing else", async () => {
    const runtimeEnv = { GATEWAY_URL: "https://example.com", DB: {} };
    await server.scheduled(
      { cron: "* * * * *" } as ScheduledController,
      runtimeEnv as unknown as Cloudflare.Env,
    );
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    expect(mocks.activateDeployingApps).toHaveBeenCalledTimes(1);
    expect(mocks.activateDeployingApps.mock.calls[0]![0]).toBe(runtimeEnv);
    // The registry it opens is the cron env's D1.
    const open = mocks.activateDeployingApps.mock.calls[0]![1] as () => object;
    expect(open()).toBeInstanceOf(Object);
    expect(mocks.runMcpMaintenance).not.toHaveBeenCalled();
  });

  it("the hourly cron sweeps the deploying apps too, for an install whose per-minute trigger was never published", async () => {
    await server.scheduled(
      { cron: "17 * * * *" } as ScheduledController,
      {
        GATEWAY_URL: "https://example.com",
        DB: {},
      } as unknown as Cloudflare.Env,
    );
    expect(mocks.activateDeployingApps).toHaveBeenCalledTimes(1);
    expect(mocks.runMcpMaintenance).toHaveBeenCalledTimes(1);
    expect(
      mocks.activateDeployingApps.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.runMcpMaintenance.mock.invocationCallOrder[0]!);
  });
});
