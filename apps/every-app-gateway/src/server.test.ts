import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRegistry, RegisteredApp } from "@every-app/perimeter";
import server, {
  clearHostnameCacheForTests,
  resolveAppByHostname,
} from "./server";
import { validateManifest } from "@every-app/perimeter/manifest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  hasAnyActiveApp: vi.fn(),
  findByHostname: vi.fn(),
  authenticate: vi.fn(),
  controlPlaneFetch: vi.fn(),
  providerFetch: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mocks.env,
  WorkerEntrypoint: class {},
}));

// The provider library imports cloudflare:workers from node_modules, where
// vi.mock cannot reach — stub the module, but keep the real control-plane
// delegation so host-dispatch tests still observe control-plane serving.
vi.mock("@/server/oauth-provider", () => ({
  getOauthProvider: vi.fn(() => ({ fetch: mocks.providerFetch })),
  syntheticExecutionContext: () => ({
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  }),
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: mocks.controlPlaneFetch },
  createServerEntry: (entry: unknown) => entry,
}));

vi.mock("./perimeter/drizzleAppRegistry", () => ({
  DrizzleAppRegistry: class {
    hasAnyActiveApp = mocks.hasAnyActiveApp;
    findByHostname = mocks.findByHostname;
  },
}));

vi.mock("./perimeter/betterAuthAuthenticator", () => ({
  createProdAuthenticator: () => ({
    authenticate: mocks.authenticate,
    hasAppAccess: vi.fn(async () => true),
  }),
}));

const TODO: RegisteredApp = {
  appId: "todo",
  hostname: "todo.example.com",
  workerName: "every-todo",
  tier: "service_binding",
  organizationId: "org-1",
  status: "active",
  manifest: validateManifest({ id: "todo" }),
};

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

beforeEach(() => {
  mocks.providerFetch.mockReset();
  mocks.providerFetch.mockImplementation(
    async (request: Request, env: unknown) => {
      const { serveControlPlane } = await import("@/server/control-plane");
      return serveControlPlane(request, env as { ASSETS?: never });
    },
  );
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

  it("never caches admin, consent or setup pages", async () => {
    mocks.env.MCP_OAUTH_ENABLED = "true";
    for (const path of [
      "/admin",
      "/admin/users",
      "/oauth/authorize?client_id=x",
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

  it("lets the native app's auth calls and token-authenticated routes through", async () => {
    const nativeSignIn = await server.fetch(
      gatewayRequest("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          "expo-origin": "everyapp://",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(nativeSignIn.status).toBe(200);

    const deployRegister = await server.fetch(
      gatewayRequest("/api/deploy/register", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          authorization: "Bearer eak_x",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(deployRegister.status).toBe(200);

    const cookielessPost = await server.fetch(
      gatewayRequest("/api/setup/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(cookielessPost.status).toBe(200);

    // Authenticated by the CLI's own secret, whatever cookie rides along.
    const deployToken = await server.fetch(
      gatewayRequest("/api/setup/deploy-token", {
        method: "POST",
        headers: {
          cookie: "session=abc",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(deployToken.status).toBe(200);
    expect(mocks.controlPlaneFetch).toHaveBeenCalledTimes(4);
  });

  it("keeps the native-app exemption to exact, metadata-free auth calls", async () => {
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
      // A browser always sends Fetch Metadata: same-site is a sibling app.
      [
        "/api/auth/sign-out",
        { "expo-origin": "everyapp://", "sec-fetch-site": "same-site" },
      ],
      [
        "/api/auth/sign-out",
        { origin: "everyapp://", "sec-fetch-site": "same-site" },
      ],
      // A real Origin wins over expo-origin.
      [
        "/api/auth/sign-out",
        { origin: "https://todo.example.com", "expo-origin": "everyapp://" },
      ],
      // The exemption covers Better Auth's routes only.
      [
        "/_serverFn/abc",
        { "expo-origin": "everyapp://", "x-tsr-serverfn": "true" },
      ],
      ["/api/setup/claim", { "expo-origin": "everyapp://" }],
      ["/api/setup/claim", { origin: "everyapp://" }],
      // A cookie POST with neither Origin nor Sec-Fetch-Site.
      ["/api/auth/sign-out", {}],
      ["/api/setup/claim", {}],
      ["/_serverFn/abc", { "x-tsr-serverfn": "true" }],
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

  it("returns 404 for every OAuth endpoint while MCP_OAUTH_ENABLED is unset", async () => {
    for (const [method, path] of [
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", "/.well-known/openid-configuration"],
      ["POST", "/oauth/register"],
      ["GET", "/oauth/authorize?client_id=x"],
      ["POST", "/oauth/token"],
      ["GET", "/oauth/userinfo"],
    ] as const) {
      const response = await server.fetch(gatewayRequest(path, { method }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "oauth_disabled" });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(mocks.providerFetch).not.toHaveBeenCalled();
  });

  it("routes OAuth endpoints to the provider when MCP_OAUTH_ENABLED is true", async () => {
    mocks.env.MCP_OAUTH_ENABLED = "true";
    mocks.providerFetch.mockResolvedValue(Response.json({ issuer: "x" }));

    const response = await server.fetch(
      gatewayRequest("/.well-known/oauth-authorization-server"),
    );
    expect(response.status).toBe(200);
    expect(mocks.providerFetch).toHaveBeenCalledOnce();
  });

  it("does not advertise OAuth on app hosts while it is off", async () => {
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
