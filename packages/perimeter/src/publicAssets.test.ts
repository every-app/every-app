/**
 * `publicAssets`: static files of the Worker's asset bundle, forwarded with
 * no identity, no public marker and no credential of any kind.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest, type GatewayDeps } from "./gateway";
import { InMemoryAppRegistry, type RegisteredApp } from "./registry";
import type { SessionAuthenticator } from "./session";
import type { ParsedHost } from "./host";
import { generateTestKeyPair, type TestKeyPair } from "./test-helpers";
import { IDENTITY_HEADER, PUBLIC_HEADER } from "./headers";
import {
  ManifestError,
  MAX_PUBLIC_ASSETS,
  validateManifest,
  validateManifestStrict,
} from "./manifest/manifest";
import { matchPublicAsset } from "./publicRoutes";

let keys: TestKeyPair;
beforeAll(async () => {
  keys = await generateTestKeyPair();
});

const ASSETS = [
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/web-app-manifest-*.png",
  "/assets/**",
  "/share/:id/og.png",
];

const APP: RegisteredApp = {
  appId: "analytics",
  hostname: "analytics.example.com",
  workerName: "every-analytics",
  tier: "service_binding",
  scope: "org",
  organizationId: "org_1",
  status: "active",
  manifest: validateManifest({
    id: "analytics",
    public: [{ path: "/assets/public-report.json" }],
    publicAssets: ASSETS,
  }),
};

const SESSION = {
  sub: "user_1",
  email: "a@b.com",
  orgId: "org_1",
  orgRole: "member",
};

function echoFetcher() {
  return {
    fetch: vi.fn(
      async (req: Request) =>
        new Response(
          JSON.stringify({
            identity: req.headers.get(IDENTITY_HEADER),
            publicMarker: req.headers.get(PUBLIC_HEADER),
            cookie: req.headers.get("cookie"),
            authorization: req.headers.get("authorization"),
            spoof: req.headers.get("x-everyapp-anything"),
            accessEmail: req.headers.get("cf-access-authenticated-user-email"),
            versionOverride: req.headers.get(
              "cloudflare-workers-version-overrides",
            ),
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  };
}

function deps(over: Partial<GatewayDeps> = {}) {
  const authenticate = vi.fn(async () => SESSION);
  const auth: SessionAuthenticator = {
    sessionCookieNames: ["better-auth.session_token"],
    authenticate,
    hasAppAccess: async () => true,
  };
  const fetcher = echoFetcher();
  const d: GatewayDeps = {
    env: {},
    registry: new InMemoryAppRegistry([APP]),
    authenticator: auth,
    privateKeyPem: keys.privateKeyPem,
    issuer: "https://home.example.com",
    resolveApp: async (h: ParsedHost, reg) => reg.findByHostname(h.host),
    fetcherFor: () => fetcher,
    ...over,
  };
  return { deps: d, authenticate, fetcher };
}

function req(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "analytics.example.com");
  return new Request(`https://analytics.example.com${path}`, {
    ...init,
    headers,
  });
}

interface Echo {
  identity: string | null;
  publicMarker: string | null;
  cookie: string | null;
  authorization: string | null;
  spoof: string | null;
  accessEmail: string | null;
  versionOverride: string | null;
}

describe("matchPublicAsset", () => {
  it("matches GET and HEAD on a declared glob", () => {
    expect(matchPublicAsset(ASSETS, "GET", "/favicon.ico").public).toBe(true);
    expect(matchPublicAsset(ASSETS, "head", "/favicon.ico").public).toBe(true);
    expect(
      matchPublicAsset(ASSETS, "GET", "/web-app-manifest-192x192.png").public,
    ).toBe(true);
    expect(matchPublicAsset(ASSETS, "GET", "/assets/a/b/c.js").public).toBe(
      true,
    );
    expect(matchPublicAsset(ASSETS, "GET", "/share/abc/og.png").public).toBe(
      true,
    );
  });

  it("never matches another method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(matchPublicAsset(ASSETS, method, "/favicon.ico").public).toBe(
        false,
      );
    }
  });

  it("never matches an undeclared, ambiguous or internal path", () => {
    expect(matchPublicAsset(ASSETS, "GET", "/favicon.svg").public).toBe(false);
    expect(matchPublicAsset(ASSETS, "GET", "/settings").public).toBe(false);
    expect(
      matchPublicAsset(ASSETS, "GET", "/assets/%2e%2e/settings").public,
    ).toBe(false);
    expect(matchPublicAsset(ASSETS, "GET", "/assets%2fx").public).toBe(false);
    expect(
      matchPublicAsset(["/assets/**"], "GET", "/assets/../__everyapp/tools")
        .public,
    ).toBe(false);
    expect(matchPublicAsset(undefined, "GET", "/favicon.ico").public).toBe(
      false,
    );
  });

  it("never matches /mcp, even from a stored glob that covers it", () => {
    expect(matchPublicAsset(["/:page"], "GET", "/mcp").public).toBe(false);
    expect(matchPublicAsset(["/mcp/**"], "GET", "/mcp/x").public).toBe(false);
    expect(matchPublicAsset(["/:page"], "GET", "/favicon.ico").public).toBe(
      true,
    );
  });
});

describe("handleGatewayRequest with publicAssets", () => {
  it("forwards an anonymous GET with no identity and no public marker", async () => {
    const { deps: d, authenticate } = deps({
      authenticator: {
        sessionCookieNames: [],
        authenticate: async () => null,
        hasAppAccess: async () => true,
      },
    });
    const res = await handleGatewayRequest(req("/favicon.ico"), d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Echo;
    expect(body.identity).toBeNull();
    expect(body.publicMarker).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("forwards a signed-in member's request as an asset too: no identity, no session read", async () => {
    const { deps: d, authenticate } = deps();
    const res = await handleGatewayRequest(
      req("/assets/index-Ab3dEf9h.js", {
        headers: { cookie: "better-auth.session_token=secret" },
      }),
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Echo;
    expect(body.identity).toBeNull();
    expect(body.publicMarker).toBeNull();
    expect(body.cookie).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("strips every inbound credential and trust header, Authorization included", async () => {
    const { deps: d } = deps();
    const res = await handleGatewayRequest(
      req("/favicon.ico", {
        method: "HEAD",
        headers: {
          authorization: "Bearer app-secret",
          cookie: "a=b; c=d",
          [IDENTITY_HEADER]: "spoofed",
          [PUBLIC_HEADER]: "spoofed",
          "x-everyapp-anything": "evil",
          "cf-access-authenticated-user-email": "ceo@example.com",
          "cloudflare-workers-version-overrides": 'every-analytics="old"',
        },
      }),
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Echo;
    expect(body).toEqual({
      identity: null,
      publicMarker: null,
      cookie: null,
      authorization: null,
      spoof: null,
      accessEmail: null,
      versionOverride: null,
    });
  });

  it("forwards a reserved Every App bearer on an asset path to nobody", async () => {
    const { deps: d, authenticate } = deps();
    const res = await handleGatewayRequest(
      req("/favicon.ico", {
        headers: { authorization: "Bearer epat_abc" },
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Echo).authorization).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("treats any other method on an asset path as a private request", async () => {
    const { deps: d } = deps({
      authenticator: {
        sessionCookieNames: [],
        authenticate: async () => null,
        hasAppAccess: async () => true,
      },
    });
    const res = await handleGatewayRequest(
      req("/favicon.ico", { method: "POST" }),
      d,
    );
    expect(res.status).toBe(401);
  });

  it("gives a member their identity on a path no glob matches", async () => {
    const { deps: d } = deps();
    const res = await handleGatewayRequest(req("/settings"), d);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Echo).identity).toBeTruthy();
  });

  it("keeps the public route's treatment where a declared public route matches", async () => {
    const { deps: d } = deps();
    const res = await handleGatewayRequest(
      req("/assets/public-report.json"),
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Echo;
    // Public means auth-optional: the signed-in member gets their identity.
    expect(body.identity).toBeTruthy();
  });

  it("keeps an asset up while the app needs setup, like a public route", async () => {
    const needsSetup = vi.fn(async () => null);
    const { deps: d } = deps({ needsSetup });
    await handleGatewayRequest(req("/favicon.ico"), d);
    expect(needsSetup).not.toHaveBeenCalled();
    await handleGatewayRequest(req("/settings"), d);
    expect(needsSetup).toHaveBeenCalledTimes(1);
  });

  it("still refuses the reserved tools contract under an asset glob", async () => {
    const { deps: d, fetcher } = deps({
      registry: new InMemoryAppRegistry([
        {
          ...APP,
          manifest: validateManifest({
            id: "analytics",
            publicAssets: ["/**/*.png"],
          }),
        },
      ]),
    });
    // `/**/*.png` is no catch-all; the tools path is answered before it.
    const res = await handleGatewayRequest(req("/__everyapp/tools/x.png"), d);
    expect(res.status).toBe(404);
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });
});

describe("publicAssets in the manifest", () => {
  it("accepts globs with public[].path's syntax", () => {
    const manifest = validateManifestStrict({
      id: "analytics",
      publicAssets: [
        "/favicon.ico",
        "/site.webmanifest",
        "/web-app-manifest-*.png",
        "/assets/**",
        "/share/:id/og.png",
      ],
    });
    expect(manifest.publicAssets).toHaveLength(5);
  });

  it.each([
    [
      "favicon.ico",
      'publicAssets: pattern path must be absolute (start with "/"): "favicon.ico"',
    ],
    [
      "/**",
      'publicAssets: pattern "/**" exposes the entire app. A catch-all public route is not allowed.',
    ],
    ["/", 'publicAssets: pattern "/" exposes the entire app.'],
    [
      "/a%2e.png",
      'publicAssets: pattern "/a%2e.png" must not contain percent-encoding',
    ],
    [
      "/a\\b.png",
      'publicAssets: pattern "/a\\b.png" must not contain backslashes.',
    ],
    [
      "/assets/../x.png",
      'publicAssets: pattern "/assets/../x.png" must not contain "." or ".." segments.',
    ],
    [
      "/:bad-name/x.png",
      'publicAssets: pattern "/:bad-name/x.png" has an invalid named segment',
    ],
    ["/__everyapp/x.png", "targets the reserved /__everyapp namespace"],
  ])("refuses %s in both validators", (path, message) => {
    for (const validate of [validateManifest, validateManifestStrict]) {
      expect(() => validate({ id: "analytics", publicAssets: [path] })).toThrow(
        message,
      );
    }
  });

  it.each([
    [
      "/mcp",
      "publicAssets: /mcp can't be a public asset; /mcp is never a static file",
    ],
    [
      "/mcp/**",
      "publicAssets: /mcp/** can't be a public asset; /mcp is never a static file",
    ],
    ["/:page", "publicAssets: /:page can't be a public asset (it covers /mcp)"],
    ["/m*", "publicAssets: /m* can't be a public asset (it covers /mcp)"],
  ])("refuses %s, which is or covers /mcp", (path, message) => {
    expect(() =>
      validateManifestStrict({ id: "analytics", publicAssets: [path] }),
    ).toThrow(message);
  });

  it(`refuses more than ${MAX_PUBLIC_ASSETS} patterns`, () => {
    const many = Array.from(
      { length: MAX_PUBLIC_ASSETS + 1 },
      (_, i) => `/icon-${i}.png`,
    );
    expect(() =>
      validateManifestStrict({ id: "analytics", publicAssets: many }),
    ).toThrow(ManifestError);
    expect(() =>
      validateManifestStrict({ id: "analytics", publicAssets: many }),
    ).toThrow(`at most ${MAX_PUBLIC_ASSETS} patterns`);
  });

  it("refuses a pattern that is not a string", () => {
    expect(() =>
      validateManifestStrict({ id: "analytics", publicAssets: [42] }),
    ).toThrow(ManifestError);
  });
});
