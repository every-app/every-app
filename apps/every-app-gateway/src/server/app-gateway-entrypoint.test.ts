import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mintIdentityJwt } from "@every-app/sdk/internal";
import {
  InMemoryAppRegistry,
  type AppRegistry,
  type RegisteredApp,
} from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
  type AppCallerProps,
  type OrganizationDirectory,
} from "./app-gateway-entrypoint";
import type { DailyCounters } from "./org-daily-cap";

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = keys.privateKey;
  publicKeyPem = keys.publicKey;
});

beforeEach(() => {
  clearAppCallerCacheForTests();
  vi.restoreAllMocks();
});

const PROPS: AppCallerProps = {
  organizationId: "org-1",
  appId: "chef",
  workerName: "every-chef",
};

function app(
  overrides: Partial<RegisteredApp> & {
    providers?: string[];
  } = {},
): RegisteredApp {
  const { providers = ["openai"], ...appOverrides } = overrides;
  return {
    appId: "chef",
    hostname: "chef.example.com",
    workerName: "every-chef",
    tier: "service_binding",
    scope: "org",
    organizationId: "org-1",
    status: "active",
    manifest: validateManifest({ id: "chef", providers }),
    ...appOverrides,
  };
}

function request(headers?: HeadersInit): Request {
  return new Request("https://gateway.internal/api/ai/openai/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ model: "gpt-5.2", input: "hello" }),
  });
}

/** `rate_limit_counters` in memory, as RateLimitCounterRepository keeps them. */
function memoryCounters(): DailyCounters & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async read(keys) {
      return new Map(
        keys.flatMap((key) =>
          counts.has(key) ? [[key, counts.get(key)!] as const] : [],
        ),
      );
    },
    async increment(keys) {
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    },
  };
}

function call(
  options: {
    props?: unknown;
    registeredApps?: RegisteredApp[];
    registry?: AppRegistry;
    inbound?: Request;
    fetchUpstream?: (request: Request) => Promise<Response>;
    env?: Record<string, string>;
    counters?: DailyCounters;
    organizations?: OrganizationDirectory;
  } = {},
) {
  const props = Object.hasOwn(options, "props") ? options.props : PROPS;
  const registeredApps = options.registeredApps ?? [app()];
  const inbound = options.inbound ?? request();
  const fetchUpstream =
    options.fetchUpstream ??
    vi.fn(async () => Response.json({ id: "response-1" }));

  return handleAppGatewayRequest({
    request: inbound,
    props,
    registry: options.registry ?? new InMemoryAppRegistry(registeredApps),
    env: {
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      OPENAI_API_KEY: "gateway-provider-key",
      JWT_PUBLIC_KEY: publicKeyPem,
      GATEWAY_URL: "https://home.example.com",
      ...options.env,
    },
    organizations: options.organizations ?? directory(),
    counters: options.counters ?? memoryCounters(),
    fetchUpstream,
  });
}

/**
 * Organizations background work may be for: Acme and Beta are active with
 * members; Gone is suspended; nothing else exists.
 */
function directory(): OrganizationDirectory & {
  isAttributable: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;
} {
  return {
    isAttributable: vi.fn(async (id: string) =>
      ["org-acme", "org-beta"].includes(id),
    ),
  };
}

/** A gateway identity for the `every-chef` Worker, as the perimeter mints it. */
function identity(orgId: string, sub = "user-1", now?: number) {
  return mintIdentityJwt(privateKeyPem, {
    subject: { sub, email: `${sub}@example.com`, orgId, orgRole: "member" },
    audience: "every-chef",
    issuer: "https://home.example.com",
    now,
  });
}

async function expectError(
  responsePromise: Promise<Response>,
  status: number,
  code: string,
): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ code });
}

describe("AppGateway caller authorization", () => {
  it("accepts valid props that match an active registry row", async () => {
    const response = await call();

    expect(response.status).toBe(200);
  });

  it("rejects missing or malformed props with a structured 401", async () => {
    await expectError(
      call({ props: undefined }),
      401,
      "missing_caller_identity",
    );
    await expectError(
      call({ props: { organizationId: "org-1", appId: "chef" } }),
      401,
      "missing_caller_identity",
    );
  });

  it("rejects a caller from the wrong organization", async () => {
    await expectError(
      call({ props: { ...PROPS, organizationId: "org-2" } }),
      403,
      "caller_not_registered",
    );
  });

  it("rejects a worker name that does not match registration", async () => {
    await expectError(
      call({ props: { ...PROPS, workerName: "every-impostor" } }),
      403,
      "caller_identity_mismatch",
    );
  });

  it("rejects an unregistered app", async () => {
    await expectError(
      call({ registeredApps: [] }),
      403,
      "caller_not_registered",
    );
  });

  it("rejects a registered app that is not active", async () => {
    await expectError(
      call({ registeredApps: [app({ status: "disabled" })] }),
      403,
      "caller_not_active",
    );
  });

  it("denies proxy access when providers is absent", async () => {
    const registeredApp = app();
    registeredApp.manifest = validateManifest({ id: "chef" });

    await expectError(
      call({ registeredApps: [registeredApp] }),
      403,
      "provider_not_allowed",
    );
  });

  it("denies a provider that is not allowlisted", async () => {
    await expectError(
      call({ registeredApps: [app({ providers: ["anthropic"] })] }),
      403,
      "provider_not_allowed",
    );
  });

  it("labels registry lookup failures as caller_registry_unavailable", async () => {
    const registry: AppRegistry = {
      hasAnyActiveApp: vi.fn(),
      findByHostname: vi.fn(),
      findByAppId: vi.fn(),
      findByOrgApp: vi
        .fn()
        .mockRejectedValue(new Error("database unavailable")),
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectError(call({ registry }), 500, "caller_registry_unavailable");
  });

  it("labels unexpected post-authorization failures as internal_error", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("unexpected logger failure");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectError(call(), 500, "internal_error");
  });
});

describe("AppGateway proxy and attribution", () => {
  it("applies the calling app's manifest AI policy", async () => {
    const restricted = {
      ...app(),
      manifest: validateManifest({
        id: "chef",
        providers: ["openai"],
        ai: { models: ["gpt-5-mini"] },
      }),
    };

    await expectError(
      call({ registeredApps: [restricted] }),
      403,
      "model_not_allowed",
    );
    await expectError(
      call({
        inbound: new Request("https://gateway.internal/api/ai/openai/v1/files"),
      }),
      403,
      "ai_route_not_allowed",
    );
  });

  it("ignores app-supplied Authorization and injects the gateway provider key", async () => {
    const fetchUpstream = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ ok: true }),
    );

    const response = await call({
      inbound: request({ authorization: "Bearer app-supplied-key" }),
      fetchUpstream,
    });

    expect(response.status).toBe(200);
    const forwarded = fetchUpstream.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("authorization")).toBe(
      "Bearer gateway-provider-key",
    );
  });

  it("logs app-level attribution when identity is absent", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect((await call()).status).toBe(200);
    expect(info).toHaveBeenCalledWith(
      "AI gateway request",
      expect.objectContaining({
        organizationId: "org-1",
        appId: "chef",
        attribution: "app",
      }),
    );
  });

  it("verifies a forwarded identity JWT, attributes the user, and strips it upstream", async () => {
    const token = await mintIdentityJwt(privateKeyPem, {
      subject: {
        sub: "user-1",
        email: "user@example.com",
        orgId: "org-1",
        orgRole: "member",
      },
      audience: "every-chef",
      issuer: "https://home.example.com",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchUpstream = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ ok: true }),
    );

    const response = await call({
      inbound: request({ "x-everyapp-identity": token }),
      fetchUpstream,
    });

    expect(response.status).toBe(200);
    expect(info).toHaveBeenCalledWith(
      "AI gateway request",
      expect.objectContaining({ attribution: "user", userId: "user-1" }),
    );
    expect(
      fetchUpstream.mock.calls[0]?.[0]?.headers.get("x-everyapp-identity"),
    ).toBeNull();
  });

  it("never attributes an identity minted for another Worker, even of the same app id", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    for (const audience of ["chef", "every-other-chef"]) {
      const token = await mintIdentityJwt(privateKeyPem, {
        subject: {
          sub: "user-1",
          email: "user@example.com",
          orgId: "org-1",
          orgRole: "member",
        },
        audience,
        issuer: "https://home.example.com",
      });
      const response = await call({
        inbound: request({ "x-everyapp-identity": token }),
      });
      expect(response.status).toBe(200);
      expect(info).toHaveBeenLastCalledWith(
        "AI gateway request",
        expect.objectContaining({ attribution: "app" }),
      );
    }
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("falls back to app attribution when a forwarded identity is invalid", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await call({
      inbound: request({ "x-everyapp-identity": "not.a.jwt" }),
    });

    expect(response.status).toBe(200);
    expect(warning).toHaveBeenCalledWith(
      "AI gateway identity attribution rejected",
      expect.objectContaining({ appId: "chef" }),
    );
    expect(info).toHaveBeenCalledWith(
      "AI gateway request",
      expect.objectContaining({ attribution: "app" }),
    );
  });
});

describe("AppGateway calls from a shared app", () => {
  // OpenSEO-like: one Worker for every organization, owned by the platform
  // organization, whose id the upload-time props carry.
  const shared = () => app({ scope: "shared", organizationId: "org-1" });
  const hosted = { GATEWAY_DEPLOYMENT_MODE: "hosted" };

  it("attributes the call to the organization of the forwarded identity", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const usage = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const counters = memoryCounters();

    const response = await call({
      registeredApps: [shared()],
      env: hosted,
      counters,
      inbound: request({ "x-everyapp-identity": await identity("org-acme") }),
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(info).toHaveBeenCalledWith(
      "AI gateway request",
      expect.objectContaining({
        organizationId: "org-acme",
        attribution: "user",
        userId: "user-1",
      }),
    );
    expect(
      usage.mock.calls.some(
        ([line]) =>
          typeof line === "string" &&
          line.includes('"ai.proxy.usage"') &&
          line.includes('"organizationId":"org-acme"'),
      ),
    ).toBe(true);
    // The cap counts the member's organization, not the platform's.
    expect([...counters.counts.keys()]).toEqual([
      expect.stringMatching(/^org-daily:ai-proxy:org-acme:\d{4}-\d{2}-\d{2}$/),
    ]);
  });

  it("refuses an invalid or expired identity with 401, never the platform organization", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchUpstream = vi.fn(async () => Response.json({}));
    const expired = await identity(
      "org-acme",
      "user-1",
      Date.now() - 10 * 60_000,
    );
    for (const token of ["not.a.jwt", expired]) {
      await expectError(
        call({
          registeredApps: [shared()],
          env: hosted,
          inbound: request({ "x-everyapp-identity": token }),
          fetchUpstream,
        }),
        401,
        "caller_identity_invalid",
      );
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses a call with no identity (background work) with 403", async () => {
    await expectError(
      call({ registeredApps: [shared()], env: hosted }),
      403,
      "caller_identity_required",
    );
  });

  it("is refused outright when the gateway has no shared apps", async () => {
    await expectError(
      call({
        registeredApps: [shared()],
        inbound: request({ "x-everyapp-identity": await identity("org-acme") }),
      }),
      403,
      "caller_not_active",
    );
  });
});

describe("AppGateway per-organization daily cap", () => {
  it("refuses an organization's calls past the hosted cap with 429 and Retry-After", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const counters = memoryCounters();
    const fetchUpstream = vi.fn(async () => Response.json({ ok: true }));
    const env = {
      GATEWAY_DEPLOYMENT_MODE: "hosted",
      AI_PROXY_ORG_DAILY_LIMIT: "2",
    };

    for (let i = 0; i < 2; i += 1) {
      const ok = await call({ env, counters, fetchUpstream });
      expect(ok.status).toBe(200);
    }
    const refused = await call({ env, counters, fetchUpstream });
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({
      error: "Too Many Requests",
      code: "org_daily_cap_exceeded",
      message: "This organization has used its 2 AI requests for today.",
    });
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);

    // Another organization's budget is its own.
    const other = await call({
      env,
      counters,
      fetchUpstream,
      props: { ...PROPS, organizationId: "org-2" },
      registeredApps: [app({ organizationId: "org-2" })],
    });
    expect(other.status).toBe(200);
  });

  it("counts nothing on a self-hosted gateway", async () => {
    const counters = memoryCounters();
    const read = vi.spyOn(counters, "read");
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await call({ counters, env: { AI_PROXY_ORG_DAILY_LIMIT: "1" } }))
          .status,
      ).toBe(200);
    }
    expect(read).not.toHaveBeenCalled();
    expect(counters.counts.size).toBe(0);
  });

  it("refuses every call when the deployment mode is invalid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expectError(
      call({ env: { GATEWAY_DEPLOYMENT_MODE: "" } }),
      429,
      "org_daily_cap_exceeded",
    );
  });
});

const SERP_URL =
  "https://gateway.internal/api/integrations/dataforseo/api.dataforseo.com/v3/serp/google/organic/live/advanced";

/** A capability call (DataForSEO), as integrationFetch sends it. */
function capabilityRequest(headers?: HeadersInit, url = SERP_URL): Request {
  return new Request(url, {
    method: url === SERP_URL ? "POST" : "GET",
    headers,
    body: url === SERP_URL ? "[]" : undefined,
  });
}

/** Chef with DataForSEO listed, an organization's own or shared. */
function withCapability(scope: "org" | "shared" = "org"): RegisteredApp {
  return app({
    scope,
    manifest: validateManifest({
      id: "chef",
      providers: ["openai"],
      capabilities: { dataforseo: { access: "read", why: "Research" } },
    }),
  });
}

/** The integration proxy's `integration.proxy.call` log lines. */
function capabilityLogLines(log: { mock: { calls: unknown[][] } }) {
  return log.mock.calls
    .map(([line]) => (typeof line === "string" ? line : ""))
    .filter((line) => line.includes('"integration.proxy.call"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const HOSTED = {
  GATEWAY_DEPLOYMENT_MODE: "hosted",
  DATAFORSEO_API_KEY: "login@example.com:secret",
};

describe("AppGateway organization attribution for a shared app", () => {
  it("attributes each identity's calls to its own organization, AI and capabilities alike", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const counters = memoryCounters();
    const upstream = vi.fn(async () => Response.json({ ok: true }));

    for (const org of ["org-acme", "org-beta"]) {
      const token = await identity(org);
      for (const inbound of [
        request({ "x-everyapp-identity": token }),
        capabilityRequest({ "x-everyapp-identity": token }),
      ]) {
        const response = await call({
          registeredApps: [withCapability("shared")],
          env: HOSTED,
          counters,
          inbound,
          fetchUpstream: upstream,
        });
        expect(response.status).toBe(200);
        await response.text();
      }
    }

    expect([...counters.counts.keys()].sort()).toEqual([
      expect.stringMatching(/^org-daily:ai-proxy:org-acme:/),
      expect.stringMatching(/^org-daily:ai-proxy:org-beta:/),
      expect.stringMatching(/^org-daily:integration-proxy:org-acme:/),
      expect.stringMatching(/^org-daily:integration-proxy:org-beta:/),
    ]);
    expect(
      capabilityLogLines(log).map((line) => [
        line["organizationId"],
        line["orgSource"],
        line["capability"],
        line["appId"],
      ]),
    ).toEqual([
      ["org-acme", "jwt", "dataforseo", "chef"],
      ["org-beta", "jwt", "dataforseo", "chef"],
    ]);
  });

  it("accepts background work's x-everyapp-org for an active organization, and strips it upstream", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const counters = memoryCounters();
    const upstream = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ ok: true }),
    );

    const capability = await call({
      registeredApps: [withCapability("shared")],
      env: HOSTED,
      counters,
      inbound: capabilityRequest({ "x-everyapp-org": "org-acme" }),
      fetchUpstream: upstream,
    });
    expect(capability.status).toBe(200);
    await capability.text();
    const ai = await call({
      registeredApps: [withCapability("shared")],
      env: HOSTED,
      counters,
      inbound: request({ "x-everyapp-org": "org-beta" }),
      fetchUpstream: upstream,
    });
    expect(ai.status).toBe(200);

    for (const [sent] of upstream.mock.calls) {
      expect(sent.headers.get("x-everyapp-org")).toBeNull();
    }
    expect(capabilityLogLines(log)[0]).toMatchObject({
      organizationId: "org-acme",
      orgSource: "header",
      attribution: "app",
    });
    expect(info).toHaveBeenCalledWith(
      "AI gateway request",
      expect.objectContaining({
        organizationId: "org-beta",
        orgSource: "header",
        attribution: "app",
      }),
    );
    expect([...counters.counts.keys()].sort()).toEqual([
      expect.stringMatching(/^org-daily:ai-proxy:org-beta:/),
      expect.stringMatching(/^org-daily:integration-proxy:org-acme:/),
    ]);
  });

  it("refuses background work for a suspended or unknown organization with 403", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upstream = vi.fn(async () => Response.json({}));
    for (const org of ["org-gone", "org-nobody", "org-1"]) {
      for (const inbound of [
        request({ "x-everyapp-org": org }),
        capabilityRequest({ "x-everyapp-org": org }),
      ]) {
        await expectError(
          call({
            registeredApps: [withCapability("shared")],
            env: HOSTED,
            inbound,
            organizations: {
              // The platform organization ("org-1") is an organization too,
              // but here it has no live member.
              isAttributable: async (id) => id === "org-acme",
            },
            fetchUpstream: upstream,
          }),
          403,
          "caller_org_not_attributable",
        );
      }
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("caches the organization check like the caller, and fails closed when it can't be made", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const organizations = directory();
    for (let i = 0; i < 3; i += 1) {
      const response = await call({
        registeredApps: [withCapability("shared")],
        env: HOSTED,
        organizations,
        inbound: capabilityRequest({ "x-everyapp-org": "org-acme" }),
      });
      expect(response.status).toBe(200);
    }
    expect(organizations.isAttributable).toHaveBeenCalledTimes(1);

    clearAppCallerCacheForTests();
    await expectError(
      call({
        registeredApps: [withCapability("shared")],
        env: HOSTED,
        organizations: {
          isAttributable: async () => {
            throw new Error("database unavailable");
          },
        },
        inbound: capabilityRequest({ "x-everyapp-org": "org-acme" }),
      }),
      500,
      "caller_registry_unavailable",
    );
  });

  it("refuses an x-everyapp-org that disagrees with the forwarded identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const token = await identity("org-acme");
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    for (const inbound of [
      request({ "x-everyapp-identity": token, "x-everyapp-org": "org-beta" }),
      capabilityRequest({
        "x-everyapp-identity": token,
        "x-everyapp-org": "org-beta",
      }),
    ]) {
      await expectError(
        call({
          registeredApps: [withCapability("shared")],
          env: HOSTED,
          inbound,
          fetchUpstream: upstream,
        }),
        403,
        "caller_org_mismatch",
      );
    }
    expect(upstream).not.toHaveBeenCalled();

    // Agreeing, the identity decides (and names the user).
    const agreed = await call({
      registeredApps: [withCapability("shared")],
      env: HOSTED,
      inbound: capabilityRequest({
        "x-everyapp-identity": token,
        "x-everyapp-org": "org-acme",
      }),
      fetchUpstream: upstream,
    });
    expect(agreed.status).toBe(200);
  });

  it("answers a capability's status without needing an organization", async () => {
    const organizations = directory();
    const counters = memoryCounters();
    const response = await call({
      registeredApps: [withCapability("shared")],
      env: HOSTED,
      organizations,
      counters,
      inbound: capabilityRequest(
        undefined,
        "https://gateway.internal/api/integrations/dataforseo",
      ),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ready: true });
    expect(organizations.isAttributable).not.toHaveBeenCalled();
    expect(counters.counts.size).toBe(0);
  });
});

describe("AppGateway organization attribution for an organization's own app", () => {
  it("refuses an x-everyapp-org naming another organization, and never consults the directory", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const organizations = directory();
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    for (const env of [{}, HOSTED]) {
      for (const inbound of [
        request({ "x-everyapp-org": "org-acme" }),
        capabilityRequest({ "x-everyapp-org": "org-acme" }),
      ]) {
        await expectError(
          call({
            registeredApps: [withCapability()],
            env: { DATAFORSEO_API_KEY: "login@example.com:secret", ...env },
            organizations,
            inbound,
            fetchUpstream: upstream,
          }),
          403,
          "caller_org_mismatch",
        );
      }
    }
    expect(upstream).not.toHaveBeenCalled();

    // Its own organization, or none: as before, the props decide.
    for (const headers of [{ "x-everyapp-org": "org-1" }, undefined]) {
      const response = await call({
        registeredApps: [withCapability()],
        env: { DATAFORSEO_API_KEY: "login@example.com:secret" },
        organizations,
        inbound: capabilityRequest(headers),
        fetchUpstream: upstream,
      });
      expect(response.status).toBe(200);
    }
    expect(organizations.isAttributable).not.toHaveBeenCalled();
  });
});

describe("AppGateway per-organization daily cap on capability calls", () => {
  it("refuses an organization's capability calls past the cap, apart from its AI cap and other organizations'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const counters = memoryCounters();
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    const env = {
      ...HOSTED,
      INTEGRATION_ORG_DAILY_LIMIT: "2",
      AI_PROXY_ORG_DAILY_LIMIT: "1",
    };
    const shared = (inbound: Request) =>
      call({
        registeredApps: [withCapability("shared")],
        env,
        counters,
        inbound,
        fetchUpstream: upstream,
      });

    for (let i = 0; i < 2; i += 1) {
      const ok = await shared(
        capabilityRequest({ "x-everyapp-org": "org-acme" }),
      );
      expect(ok.status).toBe(200);
      await ok.text();
    }
    const refused = await shared(
      capabilityRequest({ "x-everyapp-identity": await identity("org-acme") }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "org_daily_cap_exceeded",
    );
    await expect(refused.json()).resolves.toEqual({
      error: "Too Many Requests",
      code: "org_daily_cap_exceeded",
      message: "This organization has used its 2 capability calls for today.",
    });
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    expect(upstream).toHaveBeenCalledTimes(2);

    // Its AI budget is a cap of its own, and so is Beta's.
    expect(
      (await shared(request({ "x-everyapp-org": "org-acme" }))).status,
    ).toBe(200);
    const beta = await shared(
      capabilityRequest({ "x-everyapp-org": "org-beta" }),
    );
    expect(beta.status).toBe(200);
    await beta.text();
    await expectError(
      shared(request({ "x-everyapp-org": "org-acme" })),
      429,
      "org_daily_cap_exceeded",
    );
  });

  it("logs a refusal with the organization, app, capability and where the organization came from", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await call({
      registeredApps: [withCapability("shared")],
      env: { ...HOSTED, INTEGRATION_ORG_DAILY_LIMIT: "0" },
      inbound: capabilityRequest({ "x-everyapp-org": "org-acme" }),
    });
    expect(warn).toHaveBeenCalledWith(
      "AI gateway daily cap reached",
      expect.objectContaining({
        budget: "integration-proxy",
        organizationId: "org-acme",
        appId: "chef",
        capability: "dataforseo",
        orgSource: "header",
        limit: 0,
      }),
    );
  });

  it("counts only calls that would reach the provider", async () => {
    const counters = memoryCounters();
    // Not listed in the manifest: refused before any count.
    await expectError(
      call({
        registeredApps: [app()],
        env: HOSTED,
        counters,
        inbound: capabilityRequest({
          "x-everyapp-identity": await identity("org-1"),
        }),
      }),
      403,
      "capability_not_requested",
    );
    expect(counters.counts.size).toBe(0);
  });

  it("counts nothing on a self-hosted gateway", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const counters = memoryCounters();
    const read = vi.spyOn(counters, "read");
    for (let i = 0; i < 3; i += 1) {
      const response = await call({
        registeredApps: [withCapability()],
        counters,
        env: {
          DATAFORSEO_API_KEY: "login@example.com:secret",
          INTEGRATION_ORG_DAILY_LIMIT: "1",
        },
        inbound: capabilityRequest(),
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses every capability call when the deployment mode is invalid", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expectError(
      call({
        registeredApps: [withCapability()],
        env: {
          GATEWAY_DEPLOYMENT_MODE: "",
          DATAFORSEO_API_KEY: "login@example.com:secret",
        },
        inbound: capabilityRequest(),
      }),
      429,
      "org_daily_cap_exceeded",
    );
  });
});
