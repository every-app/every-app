import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../internal/index";
import {
  gatewayRefusal,
  integrationFetch,
  integrationStatus,
} from "./integrationFetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

function bindingEnv() {
  const bindingFetch = vi.fn<(request: Request) => Promise<Response>>(
    async () => Response.json({ via: "binding" }),
  );
  return { env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } }, bindingFetch };
}

describe("integrationFetch", () => {
  it("sends the provider's URL over the binding with the user's identity and no credentials", async () => {
    const { env, bindingFetch } = bindingEnv();
    const providerFetch = integrationFetch({
      env,
      provider: "dataforseo",
      request: new Request("https://seo.example.com/_serverFn/x", {
        headers: { "x-everyapp-identity": "signed-user-identity" },
      }),
    });

    await providerFetch(
      "https://api.dataforseo.com/v3/serp/google/organic/live/advanced?x=1",
      {
        method: "POST",
        headers: { authorization: "Basic app-key", cookie: "a=b" },
        body: "[]",
      },
    );

    const forwarded = bindingFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "http://every-app-gateway.internal/api/integrations/dataforseo/api.dataforseo.com/v3/serp/google/organic/live/advanced?x=1",
    );
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("cookie")).toBeNull();
    expect(forwarded?.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
  });

  it("sends background calls without an identity, dropping one the app set", async () => {
    const { env, bindingFetch } = bindingEnv();
    const providerFetch = integrationFetch({ env, provider: "dataforseo" });

    await providerFetch("https://sandbox.dataforseo.com/v3/appendix/status", {
      headers: { "x-everyapp-identity": "app-supplied" },
    });

    const forwarded = bindingFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "http://every-app-gateway.internal/api/integrations/dataforseo/sandbox.dataforseo.com/v3/appendix/status",
    );
    expect(forwarded?.headers.get("x-everyapp-identity")).toBeNull();
  });

  it("refuses a host outside the provider's", async () => {
    const { env, bindingFetch } = bindingEnv();
    const providerFetch = integrationFetch({ env, provider: "dataforseo" });

    await expect(
      providerFetch("https://attacker.example/v3/collect"),
    ).rejects.toThrow(TypeError);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("calls the provider directly with a developer key in local dev", async () => {
    const directFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({ via: "direct" }),
    );
    vi.stubGlobal("fetch", directFetch);
    const providerFetch = integrationFetch({
      env: { EVERYAPP_DEV: "1", DATAFORSEO_API_KEY: "login@example.com:pw" },
      provider: "dataforseo",
      request: new Request("http://localhost/x", {
        headers: { "x-everyapp-identity": "local-identity" },
      }),
    });

    await providerFetch("https://api.dataforseo.com/v3/appendix/user_data");

    const forwarded = directFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "https://api.dataforseo.com/v3/appendix/user_data",
    );
    expect(forwarded?.headers.get("authorization")).toBe(
      `Basic ${btoa("login@example.com:pw")}`,
    );
    expect(forwarded?.headers.get("x-everyapp-identity")).toBeNull();
  });

  it("refuses a capability the gateway doesn't offer", () => {
    const { env } = bindingEnv();
    expect(() =>
      integrationFetch({ env, provider: "toString" as "dataforseo" }),
    ).toThrowError(/Unknown capability "toString"/);
  });

  it("builds Context.dev's path and keys it as a bearer token in local dev", async () => {
    const { env, bindingFetch } = bindingEnv();
    await integrationFetch({ env, provider: "context" })(
      "https://api.context.dev/v1/scrape?url=https%3A%2F%2Fexample.com",
    );
    expect(bindingFetch.mock.calls[0]?.[0].url).toBe(
      "http://every-app-gateway.internal/api/integrations/context/api.context.dev/v1/scrape?url=https%3A%2F%2Fexample.com",
    );

    const directFetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => Response.json({}),
    );
    vi.stubGlobal("fetch", directFetch);
    await integrationFetch({
      env: { EVERYAPP_DEV: "1", CONTEXT_API_KEY: "ctx_key" },
      provider: "context",
    })("https://api.context.dev/v1/scrape");
    expect(directFetch.mock.calls[0]?.[0].headers.get("authorization")).toBe(
      "Bearer ctx_key",
    );
  });

  it("refuses a plain-http URL on the provider's host", async () => {
    const { env, bindingFetch } = bindingEnv();
    await expect(
      integrationFetch({ env, provider: "dataforseo" })(
        "http://api.dataforseo.com/v3/appendix/status",
      ),
    ).rejects.toThrow(TypeError);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("refuses a deployed-shaped env with no binding, even with a key set", () => {
    expect(() =>
      integrationFetch({
        env: { DATAFORSEO_API_KEY: "production-key" },
        provider: "dataforseo",
      }),
    ).toThrowError(ConfigurationError);
  });
});

describe("integrationStatus", () => {
  it("asks the gateway, which never calls the provider for it", async () => {
    const bindingFetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () =>
        Response.json({ requested: true, configured: false, ready: false }),
    );

    await expect(
      integrationStatus({
        env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
        provider: "dataforseo",
      }),
    ).resolves.toEqual({ requested: true, configured: false, ready: false });
    expect(String(bindingFetch.mock.calls[0]?.[0])).toBe(
      "http://every-app-gateway.internal/api/integrations/dataforseo",
    );
  });

  it("is not ready when the gateway refuses the status call", async () => {
    const bindingFetch = vi.fn(async () =>
      Response.json(
        { code: "caller_not_registered" },
        {
          status: 403,
          headers: { "x-everyapp-error": "caller_not_registered" },
        },
      ),
    );

    await expect(
      integrationStatus({
        env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
        provider: "context",
      }),
    ).resolves.toEqual({ requested: false, configured: false, ready: false });
  });

  it("is ready in local dev once .dev.vars sets the key", async () => {
    await expect(
      integrationStatus({
        env: { EVERYAPP_DEV: "1", DATAFORSEO_API_KEY: "k" },
        provider: "dataforseo",
      }),
    ).resolves.toMatchObject({ ready: true });
    await expect(
      integrationStatus({ env: { EVERYAPP_DEV: "1" }, provider: "dataforseo" }),
    ).resolves.toMatchObject({ ready: false });
  });
});

describe("gatewayRefusal", () => {
  it("reads the gateway's own refusal from its header and body", async () => {
    const refused = Response.json(
      {
        error: "Forbidden",
        code: "capability_not_requested",
        message: "This app doesn't list DataForSEO in its capabilities.",
      },
      {
        status: 403,
        headers: { "x-everyapp-error": "capability_not_requested" },
      },
    );

    await expect(gatewayRefusal(refused)).resolves.toEqual({
      status: 403,
      code: "capability_not_requested",
      message: "This app doesn't list DataForSEO in its capabilities.",
    });
  });

  it("keeps the code when the body isn't the gateway's JSON", async () => {
    const refused = new Response("upstream html", {
      status: 503,
      headers: { "x-everyapp-error": "integration_not_configured" },
    });

    await expect(gatewayRefusal(refused)).resolves.toMatchObject({
      status: 503,
      code: "integration_not_configured",
      message: expect.stringContaining("integration_not_configured"),
    });
  });

  it("is null for the provider's own answers, errors included, and leaves the body unread", async () => {
    const providerError = Response.json(
      { status_code: 40100, status_message: "Not authorized" },
      { status: 401 },
    );

    await expect(gatewayRefusal(providerError)).resolves.toBeNull();
    expect(providerError.bodyUsed).toBe(false);
  });
});
