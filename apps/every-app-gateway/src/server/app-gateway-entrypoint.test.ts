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
      OPENAI_API_KEY: "gateway-provider-key",
      JWT_PUBLIC_KEY: publicKeyPem,
      GATEWAY_URL: "https://home.example.com",
    },
    fetchUpstream,
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
      audience: "chef",
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
