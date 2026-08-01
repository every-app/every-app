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
    scopes: ["mcp:read"],
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
      'Bearer resource_metadata="https://todo.example.com/.well-known/oauth-protected-resource"',
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
      'Bearer resource_metadata="https://todo.example.com/.well-known/oauth-protected-resource"',
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
      'Bearer resource_metadata="https://todo.example.com/.well-known/oauth-protected-resource"',
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
      req("/__everyapp/tools/call", {
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
      'Bearer resource_metadata="https://todo.example.com/.well-known/oauth-protected-resource"',
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
      'Bearer resource_metadata="https://todo.example.com/.well-known/oauth-protected-resource"',
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
