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
import type { AppEmitDeps } from "./events/app-emit";
import {
  clearAppCapCache,
  type AppCapSources,
  type MonthlyCapCheck,
} from "./app-cap";

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

function call(
  options: {
    props?: unknown;
    registeredApps?: RegisteredApp[];
    registry?: AppRegistry;
    inbound?: Request;
    fetchUpstream?: (request: Request) => Promise<Response>;
    env?: Record<string, string>;
    organizations?: OrganizationDirectory;
    events?: () => Promise<AppEmitDeps>;
    caps?: AppCapSources;
    onCap?: (
      organizationId: string,
      appRowId: string,
      check: MonthlyCapCheck,
    ) => Promise<void>;
    waitUntil?: (task: Promise<unknown>) => void;
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
    caps: options.caps,
    onCap: options.onCap,
    waitUntil: options.waitUntil,
    fetchUpstream,
    ...(options.events ? { events: options.events } : {}),
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

    const response = await call({
      registeredApps: [shared()],
      env: hosted,
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
          inbound,
          fetchUpstream: upstream,
        });
        expect(response.status).toBe(200);
        await response.text();
      }
    }

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
    const upstream = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ ok: true }),
    );

    const capability = await call({
      registeredApps: [withCapability("shared")],
      env: HOSTED,
      inbound: capabilityRequest({ "x-everyapp-org": "org-acme" }),
      fetchUpstream: upstream,
    });
    expect(capability.status).toBe(200);
    await capability.text();
    const ai = await call({
      registeredApps: [withCapability("shared")],
      env: HOSTED,
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
    const response = await call({
      registeredApps: [withCapability("shared")],
      env: HOSTED,
      organizations,
      inbound: capabilityRequest(
        undefined,
        "https://gateway.internal/api/integrations/dataforseo",
      ),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ready: true });
    expect(organizations.isAttributable).not.toHaveBeenCalled();
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

describe("AppGateway and Workers AI", () => {
  const WORKERS_AI_ENV = {
    WORKERS_AI_API_TOKEN: "workers-ai-token",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
  };

  function workersAiRequest(): Request {
    return new Request(
      "https://gateway.internal/api/ai/workers-ai/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "@cf/meta/llama-4-scout-17b-16e-instruct",
          stream: true,
          messages: [],
        }),
      },
    );
  }

  it("admits an app whose manifest grants workers-ai", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchUpstream = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ id: "chat-1" }),
    );

    const response = await call({
      registeredApps: [app({ providers: ["workers-ai"] })],
      inbound: workersAiRequest(),
      env: WORKERS_AI_ENV,
      fetchUpstream,
    });

    expect(response.status).toBe(200);
    const upstream = fetchUpstream.mock.calls[0]![0];
    expect(upstream.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions",
    );
    expect(upstream.headers.get("authorization")).toBe(
      "Bearer workers-ai-token",
    );
  });

  it("refuses provider_not_allowed without the grant, in OpenAI's error shape", async () => {
    const fetchUpstream = vi.fn();

    const response = await call({
      registeredApps: [app({ providers: ["openai", "openrouter"] })],
      inbound: workersAiRequest(),
      env: WORKERS_AI_ENV,
      fetchUpstream,
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("x-everyapp-error")).toBe(
      "provider_not_allowed",
    );
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "The app manifest does not allow this provider.",
        code: "provider_not_allowed",
        type: "gateway_refusal",
      },
      code: "provider_not_allowed",
      message: "The app manifest does not allow this provider.",
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("keeps the capability routes' refusal shape", async () => {
    const response = await call({
      registeredApps: [app({ status: "disabled" })],
      inbound: capabilityRequest(),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Forbidden",
      code: "caller_not_active",
    });
  });
});

describe("AppGateway and the email capability", () => {
  const EMAIL_SEND = "https://gateway.internal/api/integrations/email/send";
  const MAILER = validateManifest({
    id: "chef",
    capabilities: { email: { access: "write", why: "Order receipts." } },
  });

  function fakeMail() {
    const send = vi.fn(async () => ({
      messageId: "<m1@example.com>",
      status: "delivered" as const,
    }));
    return {
      send,
      mail: async () => ({
        isConfigured: () => true,
        sender: () => ({ address: "noreply@example.com", name: "EveryApp" }),
        // TODO(integration): GatewayMail.provider() added by the
        // email-providers lane (this file is outside its ownership list).
        provider: () => "cloudflare" as const,
        send,
        recipientHash: async () => "0".repeat(32),
      }),
    };
  }

  function sendRequest(headers: Record<string, string> = {}) {
    return new Request(EMAIL_SEND, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        to: "diner@example.net",
        subject: "Your receipt",
        text: "Thanks.",
      }),
    });
  }

  function mailCall(options: {
    registered: RegisteredApp;
    inbound: Request;
    mode?: string;
    mail: () =>
      | Promise<never>
      | ReturnType<ReturnType<typeof fakeMail>["mail"]>;
  }) {
    return handleAppGatewayRequest({
      request: options.inbound,
      props: PROPS,
      registry: new InMemoryAppRegistry([options.registered]),
      env: {
        GATEWAY_DEPLOYMENT_MODE: options.mode ?? "self_hosted",
        JWT_PUBLIC_KEY: publicKeyPem,
        GATEWAY_URL: "https://home.example.com",
      },
      organizations: directory(),
      mail: options.mail,
    });
  }

  it("admits the send for an app whose manifest grants email", async () => {
    const { send, mail } = fakeMail();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await mailCall({
      registered: app({ manifest: MAILER }),
      inbound: sendRequest(),
      mail,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messageId: "<m1@example.com>",
      status: "delivered",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "app", to: ["diner@example.net"] }),
    );
    const line = log.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((entry) => entry["evt"] === "email.app.send");
    expect(line).toMatchObject({
      organizationId: "org-1",
      appId: "chef",
      worker: "every-chef",
      orgSource: "props",
      attribution: "app",
      status: "delivered",
    });
  });

  it("refuses the send without the grant, before loading the gateway's mail", async () => {
    const mail = vi.fn(async () => {
      throw new Error("not loaded for a refused app");
    });
    const response = await mailCall({
      registered: app({ providers: ["openai"] }),
      inbound: sendRequest(),
      mail,
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-everyapp-error")).toBe(
      "capability_not_requested",
    );
    expect(mail).not.toHaveBeenCalled();
  });

  it("attributes a shared app's background mail to the organization it names", async () => {
    const { send, mail } = fakeMail();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const shared = app({ manifest: MAILER, scope: "shared" });

    const response = await mailCall({
      registered: shared,
      inbound: sendRequest({ "x-everyapp-org": "org-acme" }),
      mode: "hosted",
      mail,
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    const line = log.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .find((entry) => entry["evt"] === "email.app.send");
    expect(line).toMatchObject({
      organizationId: "org-acme",
      orgSource: "header",
      attribution: "app",
    });

    // Naming nobody, or an organization that can't be attributed, is refused.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const [headers, code] of [
      [{}, "caller_identity_required"],
      [{ "x-everyapp-org": "org-gone" }, "caller_org_not_attributable"],
    ] as const) {
      clearAppCallerCacheForTests();
      const refused = await mailCall({
        registered: shared,
        inbound: sendRequest(headers),
        mode: "hosted",
        mail,
      });
      expect(refused.status).toBe(403);
      expect(refused.headers.get("x-everyapp-error")).toBe(code);
    }
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("the app emit route (events.app-emit-attributed-and-bounded)", () => {
  const EMIT = "https://gateway.internal/api/events/emit";

  function fakeEvents(overrides: Partial<AppEmitDeps> = {}): AppEmitDeps & {
    emit: ReturnType<typeof vi.fn>;
    countEmit: ReturnType<typeof vi.fn>;
  } {
    return {
      countEmit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
      emit: vi.fn(async () => ({ id: "evt_01TEST", deliveryIds: [] })),
      ...overrides,
    } as never;
  }

  function emitRequest(
    body: unknown,
    headers: HeadersInit = {},
    method = "POST",
  ) {
    return new Request(EMIT, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body:
        method === "GET"
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
  }

  function emitCall(
    body: unknown,
    options: {
      events?: AppEmitDeps;
      headers?: HeadersInit;
      registeredApps?: RegisteredApp[];
      props?: AppCallerProps;
      method?: string;
      env?: Record<string, string>;
    } = {},
  ) {
    return call({
      inbound: emitRequest(body, options.headers, options.method),
      events: async () => options.events ?? fakeEvents(),
      registeredApps: options.registeredApps,
      ...(options.props ? { props: options.props } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
  }

  it("answers 202 with the event's id and the prefixed type, attributed to the identity", async () => {
    const events = fakeEvents();
    const response = await emitCall(
      { event: "invoice.paid", data: { invoiceId: "inv_42", total: 1200 } },
      {
        events,
        headers: { "x-everyapp-identity": await identity("org-1", "user-7") },
        registeredApps: [app({ rowId: "row-chef" })],
      },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: "evt_01TEST",
      type: "app.chef.invoice.paid",
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit.mock.calls[0]![0]).toMatchObject({
      organizationId: "org-1",
      type: "app.chef.invoice.paid",
      version: 1,
      actor: { kind: "user", id: "user-7", email: "user-7@example.com" },
      data: { invoiceId: "inv_42", total: 1200 },
      appRowId: "row-chef",
    });
    expect(events.countEmit).toHaveBeenCalledWith("row-chef", expect.any(Date));
  });

  it("attributes an app's own call without an identity to the app itself", async () => {
    const events = fakeEvents();
    await emitCall({ event: "todo.completed", data: {} }, { events });
    expect(events.emit.mock.calls[0]![0]).toMatchObject({
      actor: { kind: "app", id: "chef" },
      type: "app.chef.todo.completed",
    });
  });

  it("refuses a bad name, bad data, data too large and a credential-named key, and emits nothing", async () => {
    const events = fakeEvents();
    await expectError(
      emitCall({ event: "Invoice Paid", data: {} }, { events }),
      400,
      "event_name_invalid",
    );
    await expectError(
      emitCall({ event: "invoice.paid", data: [1, 2] }, { events }),
      400,
      "event_data_invalid",
    );
    await expectError(
      emitCall("not json", { events }),
      400,
      "event_data_invalid",
    );
    await expectError(
      emitCall(
        { event: "invoice.paid", data: { blob: "x".repeat(9000) } },
        { events },
      ),
      413,
      "event_data_too_large",
    );
    const refused = await emitCall(
      { event: "invoice.paid", data: { customer: { apiKey: "sk-live" } } },
      { events },
    );
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      code: "event_data_refused",
      message: expect.stringContaining("apiKey"),
    });
    expect(events.emit).not.toHaveBeenCalled();
    expect(events.countEmit).not.toHaveBeenCalled();
  });

  it("takes absent or null data as an empty object, the same value the bus gets", async () => {
    for (const body of [
      { event: "todo.done" },
      { event: "todo.done", data: null },
    ]) {
      const events = fakeEvents();
      const response = await emitCall(body, { events });
      expect(response.status).toBe(202);
      expect(events.emit.mock.calls[0]![0]).toMatchObject({
        type: "app.chef.todo.done",
        data: {},
      });
    }
  });

  it("refuses a body past the cap before parsing or counting it, declared or streamed", async () => {
    const events = fakeEvents();
    await expectError(
      emitCall(
        { event: "invoice.paid", data: {} },
        { events, headers: { "content-length": "999999" } },
      ),
      413,
      "event_data_too_large",
    );
    await expectError(
      emitCall(
        `{"event":"invoice.paid","data":{"blob":"${"x".repeat(40_000)}"}}`,
        {
          events,
        },
      ),
      413,
      "event_data_too_large",
    );
    expect(events.countEmit).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After past the hourly rate, and emits nothing", async () => {
    const events = fakeEvents({
      countEmit: vi.fn(async () => ({
        allowed: false,
        retryAfterSeconds: 1234,
      })),
    });
    const response = await emitCall(
      { event: "invoice.paid", data: {} },
      { events },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1234");
    await expect(response.json()).resolves.toMatchObject({
      code: "event_rate_limited",
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a shared app must say whom the event is for, as every capability call must", async () => {
    const events = fakeEvents();
    const hosted = { GATEWAY_DEPLOYMENT_MODE: "hosted" };
    await expectError(
      emitCall(
        { event: "invoice.paid", data: {} },
        { events, registeredApps: [app({ scope: "shared" })], env: hosted },
      ),
      403,
      "caller_identity_required",
    );
    expect(events.emit).not.toHaveBeenCalled();
    const response = await emitCall(
      { event: "invoice.paid", data: {} },
      {
        events,
        registeredApps: [app({ scope: "shared" })],
        headers: { "x-everyapp-org": "org-acme" },
        env: hosted,
      },
    );
    expect(response.status).toBe(202);
    expect(events.emit.mock.calls[0]![0]).toMatchObject({
      organizationId: "org-acme",
      actor: { kind: "app", id: "chef" },
    });
  });

  it("refuses an unregistered caller before anything is read", async () => {
    const events = fakeEvents();
    await expectError(
      emitCall(
        { event: "invoice.paid", data: {} },
        { events, registeredApps: [] },
      ),
      403,
      "caller_not_registered",
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("takes POST only", async () => {
    const events = fakeEvents();
    await expectError(
      emitCall(undefined, { events, method: "GET" }),
      405,
      "method_not_allowed",
    );
  });
});

describe("the cap standing reaches the bus after the answer", () => {
  it("reports a standing near and at the cap to onCap under waitUntil, never waiting on it", async () => {
    clearAppCapCache();
    const tasks: Promise<unknown>[] = [];
    // Never resolves: a handler that awaited it would hang this test.
    const onCap = vi.fn(() => new Promise<void>(() => undefined));
    let calls = 8;
    const caps: AppCapSources = {
      effectiveMonthlyCaps: async () => ({
        calls: { cap: 10, source: "app" as const },
        cost: { cap: null, source: null },
      }),
      monthlyUsage: async () => ({ calls, costMicros: 0 }),
    };
    const options = {
      registeredApps: [app({ rowId: "row-chef" })],
      caps,
      onCap,
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    };
    const near = await call(options);
    expect(near.status).toBe(200);
    expect(onCap).toHaveBeenCalledWith(
      "org-1",
      "row-chef",
      expect.objectContaining({
        exceeded: false,
        calls: 8,
        caps: [{ kind: "calls", cap: 10, used: 8, source: "app" }],
      }),
    );
    expect(tasks).toHaveLength(1);

    calls = 10;
    const capped = await call(options);
    expect(capped.status).toBe(429);
    expect(onCap).toHaveBeenLastCalledWith(
      "org-1",
      "row-chef",
      expect.objectContaining({
        exceeded: true,
        calls: 10,
        reached: { kind: "calls", cap: 10, used: 10, source: "app" },
      }),
    );
    expect(tasks).toHaveLength(2);
  });

  it("refuses at the dollar cap with 429, saying dollars and the default", async () => {
    clearAppCapCache();
    const onCap = vi.fn(async () => undefined);
    const response = await call({
      registeredApps: [app({ rowId: "row-chef" })],
      caps: {
        effectiveMonthlyCaps: async () => ({
          calls: { cap: 1000, source: "app" as const },
          cost: { cap: 20_000_000, source: "default" as const },
        }),
        monthlyUsage: async () => ({ calls: 12, costMicros: 20_000_001 }),
      },
      onCap,
      waitUntil: () => undefined,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-everyapp-error")).toBe(
      "app_monthly_cap_exceeded",
    );
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(JSON.stringify(await response.json())).toContain(
      "has reached its monthly cap of $20.00 of provider-reported cost for this organization (the workspace default).",
    );
    expect(onCap).toHaveBeenCalledWith(
      "org-1",
      "row-chef",
      expect.objectContaining({
        exceeded: true,
        reached: expect.objectContaining({ kind: "cost" }),
      }),
    );
  });

  it("reports nothing without a cap", async () => {
    clearAppCapCache();
    const onCap = vi.fn(async () => undefined);
    const response = await call({
      registeredApps: [app({ rowId: "row-chef" })],
      caps: {
        effectiveMonthlyCaps: async () => ({
          calls: { cap: null, source: null },
          cost: { cap: null, source: null },
        }),
        monthlyUsage: async () => ({ calls: 0, costMicros: 0 }),
      },
      onCap,
      waitUntil: () => undefined,
    });
    expect(response.status).toBe(200);
    expect(onCap).not.toHaveBeenCalled();
  });
});
