import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { importSPKI, jwtVerify } from "jose";
import { handleGatewayRequest, type GatewayDeps } from "./gateway";
import { InMemoryAppRegistry, type RegisteredApp } from "./registry";
import type { AuthenticatedSession, SessionAuthenticator } from "./session";
import type { ParsedHost } from "./host";
import { generateTestKeyPair, type TestKeyPair } from "./test-helpers";
import { IDENTITY_ALG } from "@every-app/sdk/internal";
import { IDENTITY_HEADER } from "./headers";
import { validateManifest } from "./manifest/manifest";
import { AppUnreachableError } from "./getAppFetcher";

let keys: TestKeyPair;
beforeAll(async () => {
  keys = await generateTestKeyPair();
});

afterEach(() => {
  vi.useRealTimers();
});

const TODO: RegisteredApp = {
  appId: "todo",
  hostname: "todo.example.com",
  workerName: "every-todo-app",
  tier: "service_binding",
  organizationId: "org_1",
  status: "active",
  manifest: validateManifest({
    id: "todo",
    public: [
      { path: "/health" },
      { path: "/blog/*" },
      { path: "/webhook", methods: ["POST"] },
    ],
  }),
};

const SESSION: AuthenticatedSession = {
  sub: "user_1",
  email: "a@b.com",
  orgId: "org_1",
  orgRole: "member",
};

const PAT_SESSION: AuthenticatedSession = {
  ...SESSION,
  credential: {
    kind: "pat",
    channel: "api",
    actor: "pat:token_1",
    scopes: ["mcp:read", "api:write"],
  },
};

const OAUTH_SESSION: AuthenticatedSession = {
  ...SESSION,
  credential: {
    kind: "oauth",
    channel: "api",
    actor: "oauth:grant_1",
    scopes: ["todos:read"],
  },
};

/** An app fetcher that echoes back the headers + url it was called with. */
function echoFetcher() {
  return {
    fetch: async (req: Request) =>
      new Response(
        JSON.stringify({
          url: req.url,
          identity: req.headers.get(IDENTITY_HEADER),
          publicMarker: req.headers.get("x-everyapp-public"),
          cookie: req.headers.get("cookie"),
          authorization: req.headers.get("authorization"),
          spoof: req.headers.get("x-everyapp-anything"),
        }),
        { headers: { "content-type": "application/json" } },
      ),
  };
}

function deps(over: Partial<GatewayDeps> = {}): GatewayDeps {
  const auth: SessionAuthenticator = {
    authenticate: async () => SESSION,
    hasAppAccess: async () => true,
  };
  return {
    env: {},
    registry: new InMemoryAppRegistry([TODO]),
    authenticator: auth,
    privateKeyPem: keys.privateKeyPem,
    issuer: "https://home.example.com",
    resolveApp: async (h: ParsedHost, reg) => reg.findByHostname(h.host),
    fetcherFor: () => echoFetcher(),
    ...over,
  };
}

function req(
  path: string,
  init: RequestInit & { host?: string } = {},
): Request {
  const { host = "todo.example.com", ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("host", host);
  return new Request(`https://${host}${path}`, { ...rest, headers });
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

describe("handleGatewayRequest", () => {
  it("(a) a logged-in request reaches the app with a verified identity JWT", async () => {
    const res = await handleGatewayRequest(req("/tasks"), deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: string };
    expect(body.identity).toBeTruthy();
    const pub = await importSPKI(keys.publicKeyPem, IDENTITY_ALG);
    const { payload } = await jwtVerify(body.identity, pub, {
      audience: "todo",
      issuer: "https://home.example.com",
    });
    expect(payload.sub).toBe("user_1");
  });

  it("valid PAT bearer on a private route mints an api identity JWT with actor and scopes", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", {
        headers: { authorization: "Bearer epat_valid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => PAT_SESSION,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: string };
    const pub = await importSPKI(keys.publicKeyPem, IDENTITY_ALG);
    const { payload } = await jwtVerify(body.identity, pub, {
      audience: "todo",
      issuer: "https://home.example.com",
    });
    expect(payload.chan).toBe("api");
    expect(payload.act).toEqual({ sub: "pat:token_1" });
    expect(payload.scopes).toEqual(["mcp:read", "api:write"]);
  });

  it("serves OAuth protected-resource metadata on app hosts without proxying", async () => {
    const fetcher = vi.fn();
    const res = await handleGatewayRequest(
      req("/.well-known/oauth-protected-resource"),
      deps({
        oauthDiscovery: true,
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => false,
        },
        fetcherFor: () => ({ fetch: fetcher }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      resource: "https://todo.example.com",
      authorization_servers: ["https://home.example.com"],
      bearer_methods_supported: ["header"],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serves path-aware protected-resource metadata (RFC 9728) for /mcp", async () => {
    const res = await handleGatewayRequest(
      req("/.well-known/oauth-protected-resource/mcp"),
      deps({
        oauthDiscovery: true,
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => false,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe("https://todo.example.com/mcp");
  });

  it("never proxies non-GET protected-resource metadata requests, even under a broad public route", async () => {
    const fetcher = vi.fn();
    const res = await handleGatewayRequest(
      req("/.well-known/oauth-protected-resource", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      deps({
        oauthDiscovery: true,
        resolveApp: async () => ({
          ...TODO,
          manifest: validateManifest({
            id: "todo",
            public: [{ path: "/.well-known/*", methods: ["GET", "POST"] }],
          }),
        }),
        fetcherFor: () => ({ fetch: fetcher }),
      }),
    );
    expect(res.status).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a consumed OAuth credential without app access fails closed on a public route", async () => {
    const fetcher = vi.fn();
    const res = await handleGatewayRequest(
      req("/hooks/incoming", {
        headers: { authorization: "Bearer some-oauth-access-token" },
      }),
      deps({
        resolveApp: async () => ({
          ...TODO,
          manifest: validateManifest({
            id: "todo",
            public: [{ path: "/hooks/*", methods: ["GET"] }],
          }),
        }),
        authenticator: {
          authenticate: async () => OAUTH_SESSION,
          hasAppAccess: async () => false,
        },
        fetcherFor: () => ({ fetch: fetcher }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "no_app_access",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("PAT bearer with no app access returns 403", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", {
        headers: { authorization: "Bearer epat_valid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => PAT_SESSION,
          hasAppAccess: async () => false,
        },
      }),
    );

    expect(res.status).toBe(403);
  });

  it("invalid PAT bearer returns bearer 401 JSON without login redirect", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", {
        headers: {
          authorization: "Bearer epat_invalid",
          accept: "text/html",
        },
      }),
      deps({
        loginUrl: "https://home.example.com/login",
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app", error="invalid_token"',
    );
    await expect(res.json()).resolves.toEqual({ error: "unauthenticated" });
  });

  it("invalid PAT bearer on a public route still returns bearer 401", async () => {
    const res = await handleGatewayRequest(
      req("/health", {
        headers: { authorization: "Bearer epat_invalid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app", error="invalid_token"',
    );
  });

  it("invalid non-epat bearer on a private route returns bearer 401 instead of login redirect", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", {
        headers: {
          authorization: "Bearer oauth_invalid",
          accept: "text/html",
        },
      }),
      deps({
        loginUrl: "https://home.example.com/login",
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app", error="invalid_token"',
    );
  });

  it("non-epat bearer state-changing requests are CSRF-exempt", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", {
        method: "POST",
        headers: { authorization: "Bearer oauth_invalid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unauthenticated",
    );
  });

  it("PAT bearer state-changing requests are CSRF-exempt", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", {
        method: "POST",
        headers: { authorization: "Bearer epat_valid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => PAT_SESSION,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(200);
  });

  it("(b) strips credentials and spoofed trust headers on a private route", async () => {
    const res = await handleGatewayRequest(
      req("/tasks", {
        headers: {
          cookie: "session=secret",
          authorization: "Bearer app-secret",
          [IDENTITY_HEADER]: "spoofed",
          "x-everyapp-anything": "evil",
        },
      }),
      deps(),
    );
    const body = (await res.json()) as {
      cookie: string | null;
      authorization: string | null;
      spoof: string | null;
      identity: string;
    };
    expect(body.cookie).toBeNull();
    expect(body.authorization).toBeNull();
    expect(body.spoof).toBeNull();
    // identity is the freshly minted one, not the spoofed literal
    expect(body.identity).not.toBe("spoofed");
  });

  it("(c) returns 401 when unauthenticated on a private route", async () => {
    const res = await handleGatewayRequest(
      req("/tasks"),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
  });

  it("stamps security headers on the login redirect", async () => {
    const res = await handleGatewayRequest(
      req("/tasks", { headers: { accept: "text/html" } }),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
        loginUrl: "https://home.example.com/sign-in",
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://home.example.com/sign-in?return_to=https%3A%2F%2Ftodo.example.com%2Ftasks",
    );
    expectSecurityHeaders(res);
  });

  it("(d) a declared public route works unauthenticated, no identity minted", async () => {
    const res = await handleGatewayRequest(
      req("/health"),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      identity: string | null;
      publicMarker: string | null;
    };
    expect(body.identity).toBeNull();
    // The public marker is a signed JWT, never a bare flag a client could
    // spoof at a re-exposed worker.
    expect(body.publicMarker).toMatch(/^eyJ/);
  });

  it("forwards Authorization but strips trust headers on a public route", async () => {
    const res = await handleGatewayRequest(
      req("/health", {
        headers: {
          authorization: "Bearer app-secret",
          cookie: "session=secret",
          [IDENTITY_HEADER]: "spoofed",
          "x-everyapp-anything": "evil",
        },
      }),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorization: string | null;
      cookie: string | null;
      identity: string | null;
      publicMarker: string | null;
      spoof: string | null;
    };
    expect(body.authorization).toBe("Bearer app-secret");
    expect(body.cookie).toBeNull();
    expect(body.identity).toBeNull();
    expect(body.publicMarker).toMatch(/^eyJ/);
    expect(body.spoof).toBeNull();
  });

  it("preserves public-route passthrough for non-consumed non-epat bearers", async () => {
    const res = await handleGatewayRequest(
      req("/health", {
        headers: { authorization: "Bearer oauth_invalid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization: string | null };
    expect(body.authorization).toBe("Bearer oauth_invalid");
  });

  it("strips consumed oauth Authorization from outbound requests on public routes", async () => {
    const res = await handleGatewayRequest(
      req("/health", {
        headers: { authorization: "Bearer oauth_valid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => OAUTH_SESSION,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorization: string | null;
      identity: string | null;
    };
    expect(body.authorization).toBeNull();
    expect(body.identity).toBeTruthy();
  });

  it("strips epat Authorization from outbound requests on private and public routes", async () => {
    const privateRes = await handleGatewayRequest(
      req("/tasks", {
        headers: { authorization: "Bearer epat_valid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => PAT_SESSION,
          hasAppAccess: async () => true,
        },
      }),
    );
    const privateBody = (await privateRes.json()) as {
      authorization: string | null;
    };
    expect(privateBody.authorization).toBeNull();

    const publicRes = await handleGatewayRequest(
      req("/health", {
        headers: { authorization: "Bearer epat_valid" },
      }),
      deps({
        authenticator: {
          authenticate: async () => PAT_SESSION,
          hasAppAccess: async () => true,
        },
      }),
    );
    const publicBody = (await publicRes.json()) as {
      authorization: string | null;
    };
    expect(publicBody.authorization).toBeNull();
  });

  it("reuses public markers until half the SDK TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const first = await handleGatewayRequest(
      req("/health"),
      deps({
        issuer: "https://cache.example.com",
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );
    const firstBody = (await first.json()) as { publicMarker: string | null };

    vi.setSystemTime(1_000_000 + 59_000);
    const second = await handleGatewayRequest(
      req("/health"),
      deps({
        issuer: "https://cache.example.com",
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );
    const secondBody = (await second.json()) as { publicMarker: string | null };
    expect(secondBody.publicMarker).toBe(firstBody.publicMarker);

    vi.setSystemTime(1_000_000 + 61_000);
    const third = await handleGatewayRequest(
      req("/health"),
      deps({
        issuer: "https://cache.example.com",
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );
    const thirdBody = (await third.json()) as { publicMarker: string | null };
    expect(thirdBody.publicMarker).not.toBe(firstBody.publicMarker);
    vi.useRealTimers();
  });

  it("(d2) a public route with a signed-in member injects identity, not the marker (auth-optional, not auth-stripped)", async () => {
    const res = await handleGatewayRequest(req("/health"), deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      identity: string | null;
      publicMarker: string | null;
    };
    expect(body.publicMarker).toBeNull();
    expect(body.identity).toBeTruthy();
    const pub = await importSPKI(keys.publicKeyPem, IDENTITY_ALG);
    const { payload } = await jwtVerify(body.identity as string, pub, {
      audience: "todo",
      issuer: "https://home.example.com",
    });
    expect(payload.sub).toBe("user_1");
  });

  it("(d3) a public route with a signed-in NON-member serves the public marker, no identity", async () => {
    const res = await handleGatewayRequest(
      req("/health"),
      deps({
        authenticator: {
          authenticate: async () => SESSION,
          hasAppAccess: async () => false,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      identity: string | null;
      publicMarker: string | null;
    };
    expect(body.identity).toBeNull();
    expect(body.publicMarker).toMatch(/^eyJ/);
  });

  it("(d4) a private route with a signed-in NON-member is still 403", async () => {
    const res = await handleGatewayRequest(
      req("/tasks"),
      deps({
        authenticator: {
          authenticate: async () => SESSION,
          hasAppAccess: async () => false,
        },
      }),
    );
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  it("serves a public route anonymously when authentication throws", async () => {
    const hasAppAccess = vi.fn(async () => true);
    const error = new Error("authentication unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await handleGatewayRequest(
      req("/health"),
      deps({
        authenticator: {
          authenticate: async () => {
            throw error;
          },
          hasAppAccess,
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(hasAppAccess).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      identity: string | null;
      publicMarker: string | null;
    };
    expect(body.identity).toBeNull();
    expect(body.publicMarker).toMatch(/^eyJ/);
    expect(consoleError).toHaveBeenCalledWith(
      'authentication failed for public app "todo"; continuing anonymously:',
      expect.stringContaining("authentication unavailable"),
    );
    consoleError.mockRestore();
  });

  it("rejects a private route when authentication throws", async () => {
    const error = new Error("authentication unavailable");

    await expect(
      handleGatewayRequest(
        req("/tasks"),
        deps({
          authenticator: {
            authenticate: async () => {
              throw error;
            },
            hasAppAccess: async () => true,
          },
        }),
      ),
    ).rejects.toBe(error);
  });

  it("(e) /__everyapp/* is never public — 401 from outside without a session", async () => {
    const res = await handleGatewayRequest(
      req("/__everyapp/ping", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app"',
    );
  });

  it("(f) CSRF: default-denies a cookie-carrying non-GET with no origin signals", async () => {
    const res = await handleGatewayRequest(
      req("/tasks", { method: "POST", headers: { cookie: "session=abc" } }),
      deps(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_denied");
    expectSecurityHeaders(res);
  });

  it("(f1) CSRF does not apply without an ambient cookie: an unauthenticated programmatic POST gets the 401 challenge", async () => {
    // This is claude.ai's first unauthenticated POST /mcp — it must see the
    // WWW-Authenticate challenge to discover the authorization server, not an
    // opaque csrf_denied 403.
    const res = await handleGatewayRequest(
      req("/mcp", { method: "POST" }),
      deps({
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => false,
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app"',
    );
  });

  it("(f2) CSRF: allows a same-origin non-GET", async () => {
    const res = await handleGatewayRequest(
      req("/tasks", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      deps(),
    );
    expect(res.status).toBe(200);
  });

  it("(f3) CSRF: downgrades a failed public request to anonymous", async () => {
    const authenticate = vi.fn(async () => SESSION);
    const res = await handleGatewayRequest(
      req("/webhook", {
        method: "POST",
        headers: { cookie: "session=secret" },
      }),
      deps({
        authenticator: {
          authenticate,
          hasAppAccess: async () => true,
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      identity: string | null;
      publicMarker: string | null;
      cookie: string | null;
    };
    expect(body.identity).toBeNull();
    expect(body.publicMarker).toMatch(/^eyJ/);
    expect(body.cookie).toBeNull();
  });

  it("(g) 403 when the user has no access to the app", async () => {
    const res = await handleGatewayRequest(
      req("/tasks"),
      deps({
        authenticator: {
          authenticate: async () => SESSION,
          hasAppAccess: async () => false,
        },
      }),
    );
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  it("400s with security headers when the Host header is empty", async () => {
    const res = await handleGatewayRequest(
      new Request("https://todo.example.com/x", { headers: { host: "" } }),
      deps(),
    );

    expect(res.status).toBe(400);
    expectSecurityHeaders(res);
  });

  it("404s for an unknown host", async () => {
    const res = await handleGatewayRequest(
      req("/x", { host: "nope.example.com" }),
      deps(),
    );
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it("503s for a disabled app", async () => {
    const disabled = { ...TODO, status: "disabled" as const };
    const res = await handleGatewayRequest(
      req("/x"),
      deps({ registry: new InMemoryAppRegistry([disabled]) }),
    );
    expect(res.status).toBe(503);
    expectSecurityHeaders(res);
  });

  it("answers 'deploying' with Retry-After while an app is pending or binding", async () => {
    for (const status of ["pending", "binding"] as const) {
      const res = await handleGatewayRequest(
        req("/x"),
        deps({ registry: new InMemoryAppRegistry([{ ...TODO, status }]) }),
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      await expect(res.json()).resolves.toEqual({
        error: "app_deploying",
        status,
      });
      expectSecurityHeaders(res);
    }
  });

  it("stamps headers and strips cookie domains from a non-101 response to an upgrade request", async () => {
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append(
      "set-cookie",
      "session=app; Domain=example.com; Path=/; HttpOnly",
    );
    const original = new Response("upgrade rejected", {
      status: 426,
      headers,
    });
    const wsFetcher = { fetch: async () => original };
    const res = await handleGatewayRequest(
      req("/ws", { headers: { upgrade: "websocket" } }),
      deps({ fetcherFor: () => wsFetcher }),
    );

    expect(res.status).toBe(426);
    expect(res).not.toBe(original);
    expectSecurityHeaders(res);
    expect(res.headers.getSetCookie()).toEqual([
      "session=app; Path=/; HttpOnly",
    ]);
  });

  it("passes a true 101 response through untouched", async () => {
    // Node's Response constructor rejects status 101. Shadowing the status on
    // a real Response exercises the same branch without cloning it.
    const headers = new Headers({ "content-type": "text/plain" });
    headers.append("set-cookie", "session=app; Domain=example.com; Path=/");
    const original = new Response(null, { headers });
    Object.defineProperty(original, "status", { value: 101 });
    const wsFetcher = { fetch: async () => original };
    const res = await handleGatewayRequest(
      req("/ws", { headers: { upgrade: "websocket" } }),
      deps({ fetcherFor: () => wsFetcher }),
    );

    expect(res).toBe(original);
    expect(res.headers.get("x-content-type-options")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([
      "session=app; Domain=example.com; Path=/",
    ]);
  });

  it("stamps security headers on app failure responses", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const unreachable = await handleGatewayRequest(
      req("/tasks"),
      deps({
        fetcherFor: () => ({
          fetch: async () => {
            throw new AppUnreachableError("missing binding");
          },
        }),
      }),
    );
    const appError = await handleGatewayRequest(
      req("/tasks"),
      deps({
        fetcherFor: () => ({
          fetch: async () => {
            throw new Error("app crashed");
          },
        }),
      }),
    );

    expect(unreachable.status).toBe(503);
    expectSecurityHeaders(unreachable);
    expect(appError.status).toBe(502);
    expectSecurityHeaders(appError);
    consoleError.mockRestore();
  });

  it("stamps security headers on the proxied HTML response", async () => {
    const htmlFetcher = {
      fetch: async () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        }),
    };
    const res = await handleGatewayRequest(
      req("/"),
      deps({ fetcherFor: () => htmlFetcher }),
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("logs proxy metadata without the request path", async () => {
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    const res = await handleGatewayRequest(req("/tasks/private"), deps());

    expect(res.status).toBe(200);
    expect(consoleLog).toHaveBeenCalledOnce();
    const entry = JSON.parse(consoleLog.mock.calls[0]![0] as string) as Record<
      string,
      unknown
    >;
    expect(entry).toMatchObject({
      evt: "proxy",
      app: "todo",
      method: "GET",
      status: 200,
      mode: "user",
    });
    expect(entry.ms).toEqual(expect.any(Number));
    expect(entry).not.toHaveProperty("path");
    consoleLog.mockRestore();
  });
});

describe("OAuth discovery (MCP_OAUTH_ENABLED)", () => {
  const anonymous: SessionAuthenticator = {
    authenticate: async () => null,
    hasAppAccess: async () => false,
  };

  it("404s protected-resource metadata by default and never proxies it", async () => {
    const fetcher = vi.fn();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await handleGatewayRequest(
        req(path),
        deps({
          authenticator: anonymous,
          fetcherFor: () => ({ fetch: fetcher }),
        }),
      );
      expect(res.status).toBe(404);
      expectSecurityHeaders(res);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stops advertising resource_metadata on the /mcp 401 by default", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", { method: "POST" }),
      deps({ authenticator: anonymous }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app"',
    );
  });

  it("points the 401 at the metadata when OAuth is enabled", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", { method: "POST" }),
      deps({ authenticator: anonymous, oauthDiscovery: true }),
    );
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://todo.example.com/.well-known/oauth-protected-resource"',
    );
  });
});

describe("server-function guard", () => {
  const SERVER_FN = "/_serverFn/abc123";

  async function call(
    path: string,
    headers: Record<string, string>,
    init: RequestInit & { app?: RegisteredApp } = {},
  ) {
    const fetcher = vi.fn(async () => new Response("ok"));
    const { app, ...rest } = init;
    const res = await handleGatewayRequest(
      req(path, { ...rest, headers: { cookie: "session=abc", ...headers } }),
      deps({
        fetcherFor: () => ({ fetch: fetcher }),
        ...(app ? { resolveApp: async () => app } : {}),
      }),
    );
    return { res, fetcher };
  }

  it("rejects a GET mutation reached by navigation (link or redirect)", async () => {
    const { res, fetcher } = await call(
      `${SERVER_FN}?createServerFn&payload=%7B%7D`,
      {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-site": "same-origin",
      },
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "server_fn_denied",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an HTML request without Fetch Metadata", async () => {
    const { res } = await call(`${SERVER_FN}?payload=x`, {
      accept: "text/html,application/xhtml+xml",
      "x-tsr-serverfn": "true",
    });
    expect(res.status).toBe(403);
  });

  it("rejects cross-site and same-site (sibling app) calls on every method", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      for (const method of ["GET", "POST"]) {
        const { res, fetcher } = await call(
          SERVER_FN,
          { "sec-fetch-site": site, "x-tsr-serverfn": "true" },
          { method },
        );
        expect(res.status).toBe(403);
        expect(fetcher).not.toHaveBeenCalled();
      }
    }
  });

  it("rejects a same-origin call without the TanStack client header", async () => {
    const { res } = await call(
      SERVER_FN,
      { "sec-fetch-site": "same-origin" },
      { method: "POST" },
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      reason: "missing server function client header",
    });
  });

  it("lets same-origin calls from current and 1.140-era clients through", async () => {
    const clientHeaders: Record<string, string>[] = [
      { "x-tsr-serverfn": "true" },
      { "x-tsr-redirect": "manual" },
    ];
    for (const header of clientHeaders) {
      const { res, fetcher } = await call(
        SERVER_FN,
        {
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          ...header,
        },
        { method: "POST" },
      );
      expect(res.status).toBe(200);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("guards encoded and dot-segment spellings of the server-function path", async () => {
    for (const path of [
      "/%5FserverFn/abc123",
      "/x/%2e%2e/_serverFn/abc123",
      // A malformed escape elsewhere must not stop the %5F from decoding.
      "/%5FserverFn/abc123/%ZZ",
      "/%5FserverFn/abc123/%E0",
    ]) {
      const { res, fetcher } = await call(path, {
        "sec-fetch-site": "cross-site",
      });
      expect(res.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("guards the server-function base an app declares in its manifest", async () => {
    const app = {
      ...TODO,
      manifest: validateManifest({
        id: "todo",
        serverFnBase: "/app/_serverFn",
      }),
    };
    const { res, fetcher } = await call(
      "/app/_serverFn/abc123",
      { "sec-fetch-site": "cross-site" },
      { app },
    );
    expect(res.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves other paths alone", async () => {
    const { res } = await call("/tasks", {
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
    });
    expect(res.status).toBe(200);
  });

  it("can be turned off per app in the manifest", async () => {
    const { res } = await call(
      SERVER_FN,
      { "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" },
      {
        app: {
          ...TODO,
          manifest: validateManifest({ id: "todo", serverFnGuard: false }),
        },
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("WebSocket Origin check", () => {
  function upgrade(headers: Record<string, string>): Request {
    return req("/sync", { headers: { upgrade: "websocket", ...headers } });
  }

  it("rejects a cookie-authenticated upgrade from another origin", async () => {
    const fetcher = vi.fn();
    for (const origin of [
      "https://evil.example.net",
      "https://notes.example.com",
    ]) {
      const res = await handleGatewayRequest(
        upgrade({ cookie: "session=abc", origin }),
        deps({ fetcherFor: () => ({ fetch: fetcher }) }),
      );
      expect(res.status).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a cookie-authenticated upgrade with no Origin", async () => {
    const res = await handleGatewayRequest(
      upgrade({ cookie: "session=abc" }),
      deps(),
    );
    expect(res.status).toBe(403);
  });

  it("lets a same-origin upgrade through with the member's identity", async () => {
    const res = await handleGatewayRequest(
      upgrade({ cookie: "session=abc", origin: "https://todo.example.com" }),
      deps(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: string | null };
    expect(body.identity).toEqual(expect.any(String));
  });

  it("exempts bearer-only upgrades", async () => {
    const res = await handleGatewayRequest(
      upgrade({ authorization: "Bearer epat_valid" }),
      deps({
        authenticator: {
          authenticate: async () => PAT_SESSION,
          hasAppAccess: async () => true,
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("downgrades a cross-origin upgrade on a public route to anonymous", async () => {
    const authenticate = vi.fn(async () => SESSION);
    const res = await handleGatewayRequest(
      req("/blog/live", {
        headers: {
          upgrade: "websocket",
          cookie: "session=abc",
          origin: "https://evil.example.net",
        },
      }),
      deps({ authenticator: { authenticate, hasAppAccess: async () => true } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      identity: string | null;
      publicMarker: string | null;
    };
    expect(body.identity).toBeNull();
    expect(body.publicMarker).toEqual(expect.any(String));
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("Worker version overrides", () => {
  it("never forwards an inbound version-override header to the app", async () => {
    let forwarded: string | null = "unset";
    const res = await handleGatewayRequest(
      req("/tasks", {
        headers: {
          "cloudflare-workers-version-overrides":
            'every-todo="10000000-0000-0000-0000-000000000000"',
        },
      }),
      deps({
        fetcherFor: () => ({
          fetch: async (outbound: Request) => {
            forwarded = outbound.headers.get(
              "cloudflare-workers-version-overrides",
            );
            return new Response("ok");
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(forwarded).toBeNull();
  });
});

describe("internal tools contract", () => {
  it("404s /__everyapp/tools/* from outside, signed in or not, under any spelling", async () => {
    const fetcher = vi.fn();
    // These go through new Request(), which resolves dot segments (so the
    // "/./" and "/x/../" spellings arrive canonical). The raw, unparsed
    // spellings are covered by isReservedToolsPath's own tests.
    const spellings = [
      "/__everyapp/tools/call",
      "/__everyapp/tools/list",
      "/__everyapp/tools",
      "/__everyapp/tools/",
      "/__EVERYAPP/Tools/call",
      "/__everyapp//tools/call",
      "/__everyapp/./tools/call",
      "/x/../__everyapp/tools/call",
      "/x/%2e%2e/__everyapp/tools/call",
      "/__everyapp%2ftools%2fcall",
      "/__everyapp%252ftools%252fcall",
      "/__everyapp%5ctools%5ccall",
      "/%5f%5feveryapp/tools/call",
      "/__everyapp/tools/call/%zz",
    ];
    for (const session of [SESSION, PAT_SESSION, null]) {
      for (const path of spellings) {
        const res = await handleGatewayRequest(
          req(path, {
            method: "POST",
            headers: {
              "sec-fetch-site": "same-origin",
              ...(session?.credential
                ? { authorization: "Bearer epat_x" }
                : {}),
            },
          }),
          deps({
            authenticator: {
              authenticate: async () => session,
              hasAppAccess: async () => true,
            },
            fetcherFor: () => ({ fetch: fetcher }),
          }),
        );
        expect(res.status, path).toBe(404);
        expectSecurityHeaders(res);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves look-alike paths to the app", async () => {
    for (const path of [
      "/__everyapp/toolsx",
      "/tools/call",
      "/api/__everyapp/tools",
    ]) {
      const res = await handleGatewayRequest(
        req(path, {
          method: "POST",
          headers: { "sec-fetch-site": "same-origin" },
        }),
        deps(),
      );
      expect(res.status, path).toBe(200);
    }
  });
});

describe("ToolBus /mcp interception", () => {
  const MCP_POST = {
    method: "POST",
    headers: {
      authorization: "Bearer epat_valid",
      "content-type": "application/json",
    },
    body: "{}",
  } satisfies RequestInit;

  function patDeps(over: Partial<GatewayDeps> = {}): GatewayDeps {
    return deps({
      authenticator: {
        authenticate: async () => PAT_SESSION,
        hasAppAccess: async () => true,
      },
      ...over,
    });
  }

  it("hands an authenticated /mcp request to the ToolBus instead of the app", async () => {
    const fetcher = vi.fn();
    const interceptMcp = vi.fn(async () =>
      Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
    );
    const res = await handleGatewayRequest(
      req("/mcp", MCP_POST),
      patDeps({ interceptMcp, fetcherFor: () => ({ fetch: fetcher }) }),
    );

    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(interceptMcp).toHaveBeenCalledOnce();
    expect(interceptMcp).toHaveBeenCalledWith({
      request: expect.any(Request),
      app: TODO,
      session: PAT_SESSION,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("proxies to the app when the ToolBus declines (no catalog)", async () => {
    const res = await handleGatewayRequest(
      req("/mcp", MCP_POST),
      patDeps({ interceptMcp: async () => null }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: string | null };
    expect(body.identity).toEqual(expect.any(String));
  });

  it("challenges and refuses before the ToolBus ever runs", async () => {
    const interceptMcp = vi.fn(async () => new Response("served"));
    const unauthenticated = await handleGatewayRequest(
      req("/mcp", { method: "POST" }),
      deps({
        interceptMcp,
        authenticator: {
          authenticate: async () => null,
          hasAppAccess: async () => true,
        },
      }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app"',
    );

    const noAccess = await handleGatewayRequest(
      req("/mcp", MCP_POST),
      patDeps({
        interceptMcp,
        authenticator: {
          authenticate: async () => PAT_SESSION,
          hasAppAccess: async () => false,
        },
      }),
    );
    expect(noAccess.status).toBe(403);

    const crossSiteCookie = await handleGatewayRequest(
      req("/mcp", {
        method: "POST",
        headers: { cookie: "session=abc", origin: "https://evil.example" },
      }),
      deps({ interceptMcp }),
    );
    expect(crossSiteCookie.status).toBe(403);
    expect(interceptMcp).not.toHaveBeenCalled();
  });

  it("serves a same-origin cookie session", async () => {
    const interceptMcp = vi.fn(async () => new Response("served"));
    const res = await handleGatewayRequest(
      req("/mcp", {
        method: "POST",
        headers: { cookie: "session=abc", origin: "https://todo.example.com" },
      }),
      deps({ interceptMcp }),
    );
    expect(res.status).toBe(200);
    expect(interceptMcp).toHaveBeenCalledWith(
      expect.objectContaining({ session: SESSION }),
    );
  });

  it("leaves /mcp to apps that keep MCP or declare it public, and other paths alone", async () => {
    const interceptMcp = vi.fn(async () => new Response("served"));
    const ownMcp: RegisteredApp = {
      ...TODO,
      manifest: validateManifest({ id: "todo", mcp: "app" }),
    };
    const publicMcp: RegisteredApp = {
      ...TODO,
      manifest: validateManifest({
        id: "todo",
        public: [{ path: "/mcp", methods: ["POST"] }],
      }),
    };
    for (const app of [ownMcp, publicMcp]) {
      const res = await handleGatewayRequest(
        req("/mcp", MCP_POST),
        patDeps({
          interceptMcp,
          registry: new InMemoryAppRegistry([app]),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).not.toBe("served");
    }
    for (const path of ["/mcp/", "/mcp/x", "/api/mcp", "/MCP"]) {
      await handleGatewayRequest(
        req(path, MCP_POST),
        patDeps({ interceptMcp }),
      );
    }
    expect(interceptMcp).not.toHaveBeenCalled();
  });
});

describe("MCP-only tokens", () => {
  const credential = (scopes: string[], kind: "pat" | "oauth" = "pat") => ({
    ...SESSION,
    credential: {
      kind,
      channel: "api" as const,
      actor: `${kind}:token_1`,
      scopes,
    },
  });

  function call(
    path: string,
    session: AuthenticatedSession,
    over: Partial<GatewayDeps> = {},
    init: RequestInit = {},
  ) {
    return handleGatewayRequest(
      req(path, {
        ...init,
        headers: { authorization: "Bearer epat_valid", ...init.headers },
      }),
      deps({
        authenticator: {
          authenticate: async () => session,
          hasAppAccess: async () => true,
        },
        ...over,
      }),
    );
  }

  it("refuse every app route but /mcp with 403 token_scope", async () => {
    const fetcher = vi.fn();
    for (const session of [
      credential(["mcp:read"]),
      credential(["mcp:read", "mcp:write"]),
      credential(["mcp:read"], "oauth"),
    ]) {
      for (const [path, init] of [
        ["/tasks", {}],
        ["/api/todos", { method: "POST" }],
        ["/health", {}], // public routes too
        ["/mcp/", { method: "POST" }],
        ["/MCP", { method: "POST" }],
      ] as const) {
        const res = await call(
          path,
          session,
          {
            fetcherFor: () => ({ fetch: fetcher }),
          },
          init,
        );
        expect(res.status, path).toBe(403);
        expect(await res.json()).toEqual({
          error: "forbidden",
          reason: "token_scope",
        });
        expectSecurityHeaders(res);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("let them through at /mcp, to the ToolBus or to the app's own server", async () => {
    const session = credential(["mcp:read"]);
    const interceptMcp = vi.fn(async () => new Response("toolbus"));
    const served = await call(
      "/mcp",
      session,
      { interceptMcp },
      {
        method: "POST",
      },
    );
    expect(await served.text()).toBe("toolbus");

    const proxied = await call(
      "/mcp",
      session,
      { interceptMcp: async () => null },
      { method: "POST" },
    );
    expect(proxied.status).toBe(200);
    const { identity } = (await proxied.json()) as { identity: string };
    const pub = await importSPKI(keys.publicKeyPem, IDENTITY_ALG);
    const { payload } = await jwtVerify(identity, pub);
    expect(payload["scopes"]).toEqual(["mcp:read"]);
  });

  it("leave full-access and API-scoped tokens on every route", async () => {
    for (const scopes of [["*"], ["mcp:read", "todos:write"], ["todos:read"]]) {
      const res = await call("/tasks", credential(scopes));
      expect(res.status, scopes.join(" ")).toBe(200);
      const { identity } = (await res.json()) as { identity: string };
      expect(identity).toBeTruthy();
    }
  });
});
