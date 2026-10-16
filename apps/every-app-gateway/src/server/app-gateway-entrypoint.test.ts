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
    counters: options.counters ?? memoryCounters(),
    fetchUpstream,
  });
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
