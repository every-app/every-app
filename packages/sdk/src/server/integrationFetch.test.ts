import { afterEach, describe, expect, expectTypeOf, vi } from "vitest";
import { TEST_ORGANIZATION, it } from "../../test/inOrganization";
import { withOrganization } from "./context";
import { ConfigurationError } from "../internal/index";
import { integrationFetch, integrationStatus } from "./integrationFetch";
import { gatewayRefusal } from "./refusal";

/** A status or refusal with nothing to set. */
const NO_SETUP = { settings: [], setup: null, command: null };

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
      for: new Request("https://seo.example.com/_serverFn/x", {
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
      for: new Request("http://localhost/x", {
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

  it("sends a provider outside the catalog over the binding for the gateway to resolve, and has no local fallback for it", async () => {
    const { env, bindingFetch } = bindingEnv();
    const call = integrationFetch({ env, provider: "northwind" });
    await call("https://api.northwind.io/v1/customers?limit=1", {
      headers: { authorization: "Bearer app-key" },
    });
    const forwarded = bindingFetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe(
      "http://every-app-gateway.internal/api/integrations/northwind/api.northwind.io/v1/customers?limit=1",
    );
    expect(forwarded.headers.get("authorization")).toBeNull();
    await expect(
      call("http://api.northwind.io/v1/customers"),
    ).rejects.toThrowError(/https URLs only/);
    expect(() =>
      integrationFetch({ env: { EVERYAPP_DEV: "1" }, provider: "northwind" }),
    ).toThrowError(/isn't in the built-in provider catalog/);
  });

  describe("a registered provider in local dev, from .everyapp/providers", () => {
    const northwind = {
      id: "northwind",
      name: "Northwind",
      docs: "https://developer.northwind.io/keys",
      hosts: ["api.northwind.io"],
      auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
    };
    const devEnv = (
      files: Array<{ file: string; spec: unknown }>,
      settings: Record<string, string> = { NORTHWIND_API_KEY: "sk_test_dev" },
    ) => ({
      EVERYAPP_DEV: "1",
      EVERYAPP_DEV_PROVIDERS: JSON.stringify(files),
      ...settings,
    });

    it("calls the provider directly with the developer's key, put where the spec says", async () => {
      const directFetch = vi.fn<(request: Request) => Promise<Response>>(
        async () => Response.json({ via: "direct" }),
      );
      vi.stubGlobal("fetch", directFetch);
      const env = devEnv([
        { file: ".everyapp/providers/northwind.json", spec: northwind },
      ]);
      await integrationFetch({ env, provider: "northwind" })(
        "https://api.northwind.io/v1/customers?limit=1",
        { headers: { authorization: "Bearer app-key" } },
      );
      const forwarded = directFetch.mock.calls[0]?.[0] as Request;
      expect(forwarded.url).toBe(
        "https://api.northwind.io/v1/customers?limit=1",
      );
      expect(forwarded.headers.get("authorization")).toBe("Bearer sk_test_dev");

      // Only the spec's hosts.
      await expect(
        integrationFetch({ env, provider: "northwind" })(
          "https://attacker.example/v1/customers",
        ),
      ).rejects.toThrowError(/only reaches api\.northwind\.io/);

      // A query-key spec puts the key on the query string.
      directFetch.mockClear();
      const weather = {
        id: "fabrikam",
        name: "Fabrikam",
        docs: "https://fabrikam.net/api",
        hosts: ["api.fabrikam.net"],
        auth: { kind: "query", secret: "FABRIKAM_API_KEY", param: "key" },
      };
      await integrationFetch({
        env: devEnv(
          [{ file: ".everyapp/providers/fabrikam.json", spec: weather }],
          { FABRIKAM_API_KEY: "fb_dev" },
        ),
        provider: "fabrikam",
      })("https://api.fabrikam.net/v1/forecast?q=Oslo");
      expect((directFetch.mock.calls[0]?.[0] as Request).url).toBe(
        "https://api.fabrikam.net/v1/forecast?q=Oslo&key=fb_dev",
      );
    });

    it("says what to set when the spec's key isn't in .dev.vars", () => {
      expect(() =>
        integrationFetch({
          env: devEnv(
            [{ file: ".everyapp/providers/northwind.json", spec: northwind }],
            {},
          ),
          provider: "northwind",
        }),
      ).toThrowError(
        "Northwind is unavailable: deploy with the EVERY_APP_GATEWAY binding, or set NORTHWIND_API_KEY in .dev.vars for local development.",
      );
    });

    it("names the file when the spec for the id asked for doesn't parse, and ignores the others", () => {
      const env = devEnv([
        { file: ".everyapp/providers/broken.json", spec: "{not json" },
        {
          file: ".everyapp/providers/northwind.json",
          spec: { ...northwind, hosts: [] },
        },
      ]);
      expect(() =>
        integrationFetch({ env, provider: "northwind" }),
      ).toThrowError(
        /^\.everyapp\/providers\/northwind\.json isn't a provider spec: hosts: required.*everyapp provider show northwind --save/,
      );
      expect(() => integrationFetch({ env, provider: "broken" })).toThrowError(
        /^\.everyapp\/providers\/broken\.json isn't JSON\./,
      );
      expect(() => integrationFetch({ env, provider: "nope" })).toThrowError(
        /"nope" isn't in the built-in provider catalog, and no \.everyapp\/providers\/nope\.json describes it/,
      );
    });

    it("leaves a registered provider to the gateway when the binding is there, spec file or not", async () => {
      const { env, bindingFetch } = bindingEnv();
      await integrationFetch({
        env: {
          ...env,
          EVERYAPP_DEV_PROVIDERS: JSON.stringify([
            { file: ".everyapp/providers/northwind.json", spec: northwind },
          ]),
          NORTHWIND_API_KEY: "sk_test_dev",
        },
        provider: "northwind",
      })("https://api.northwind.io/v1/customers");
      const forwarded = bindingFetch.mock.calls[0]?.[0] as Request;
      expect(forwarded.url).toBe(
        "http://every-app-gateway.internal/api/integrations/northwind/api.northwind.io/v1/customers",
      );
      expect(forwarded.headers.get("authorization")).toBeNull();
    });

    it("reports its status from the spec and .dev.vars", async () => {
      const files = [
        { file: ".everyapp/providers/northwind.json", spec: northwind },
      ];
      expect(
        await integrationStatus({ env: devEnv(files), provider: "northwind" }),
      ).toEqual({
        requested: true,
        configured: true,
        ready: true,
        ...NO_SETUP,
      });
      expect(
        await integrationStatus({
          env: devEnv(files, {}),
          provider: "northwind",
        }),
      ).toEqual({
        requested: true,
        configured: false,
        ready: false,
        settings: ["NORTHWIND_API_KEY"],
        setup:
          "Northwind isn't set up for local development: set NORTHWIND_API_KEY in .dev.vars.",
        command: null,
      });
      await expect(
        integrationStatus({ env: devEnv([]), provider: "northwind" }),
      ).rejects.toThrowError(/no \.everyapp\/providers\/northwind\.json/);
    });
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
    ).resolves.toEqual({
      requested: true,
      configured: false,
      ready: false,
      ...NO_SETUP,
    });
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
    ).resolves.toEqual({
      requested: false,
      configured: false,
      ready: false,
      ...NO_SETUP,
    });
  });

  it("asks the gateway about a provider outside the catalog, and refuses one in local dev", async () => {
    // Deployed: the gateway's registry may have it; a refusal reads as unavailable.
    const bindingFetch = vi.fn(async () =>
      Response.json({ error: "not found" }, { status: 400 }),
    );
    await expect(
      integrationStatus({
        env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
        provider: "northwind",
      }),
    ).resolves.toEqual({
      requested: false,
      configured: false,
      ready: false,
      ...NO_SETUP,
    });
    // Whose status: the test's organization, as a call would carry it.
    expect(bindingFetch).toHaveBeenCalledWith(
      "http://every-app-gateway.internal/api/integrations/northwind",
      { headers: expect.any(Headers) },
    );
    const [, init] = bindingFetch.mock.calls[0] as unknown as [
      string,
      { headers: Headers },
    ];
    expect(init.headers.get("x-everyapp-org")).toBe(TEST_ORGANIZATION);
    // Local dev knows the catalog only.
    await expect(
      integrationStatus({ env: { EVERYAPP_DEV: "1" }, provider: "northwind" }),
    ).rejects.toThrowError(ConfigurationError);
    await expect(
      integrationStatus({ env: { EVERYAPP_DEV: "1" }, provider: "openai" }),
    ).rejects.toThrowError(/is an AI provider/);
  });

  it("carries the person's identity when the status is for a request", async () => {
    // An OAuth provider's `connection` is the caller's: the status carries
    // the inbound request's identity as a call would.
    const bindingFetch = vi.fn(async () =>
      Response.json({ requested: true, configured: true, ready: true }),
    );
    const inbound = new Request("https://app.example/page", {
      headers: { "x-everyapp-identity": "signed-user-identity" },
    });
    await integrationStatus({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      provider: "google-workspace",
      for: inbound,
    });
    const [url, init] = bindingFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://every-app-gateway.internal/api/integrations/google-workspace",
    );
    expect(new Headers(init.headers).get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
    // Background work names its organization instead.
    await integrationStatus({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      provider: "google-workspace",
      for: { background: true, organizationId: "org_1" },
    });
    const [, background] = bindingFetch.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(background.headers).get("x-everyapp-org")).toBe("org_1");
    expect(new Headers(background.headers).has("x-everyapp-identity")).toBe(
      false,
    );
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
      ...NO_SETUP,
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

describe("the email capability", () => {
  it("isn't reached with integrationFetch: it has sendEmail()", () => {
    const { env } = bindingEnv();
    expect(() =>
      integrationFetch({
        env,
        // email is a service, not a provider with a key.
        provider: "email",
      }),
    ).toThrow(
      new ConfigurationError(
        "email is a gateway service: call its helper from @every-app/sdk/server (sendEmail(), listMembers()), not integrationFetch().",
      ),
    );
  });

  it("asks the gateway for its status, senders included", async () => {
    const status = {
      capability: "email",
      requested: true,
      configured: true,
      ready: true,
      sender: { address: "noreply@example.com", name: "EveryApp" },
      senders: ["*@mail.example.com"],
      provider: "resend",
    };
    const bindingFetch = vi.fn(async () => Response.json(status));
    const result = await integrationStatus({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      provider: "email",
    });
    expect(result).toEqual({ ...status, ...NO_SETUP });
    expectTypeOf(result.senders).toEqualTypeOf<string[]>();
    expectTypeOf(result.provider).toEqualTypeOf<
      "cloudflare" | "resend" | null
    >();
    expect(bindingFetch).toHaveBeenCalledWith(
      "http://every-app-gateway.internal/api/integrations/email",
      { headers: expect.any(Headers) },
    );
  });

  it("is unavailable, with no sender or senders, when the gateway refuses the status call", async () => {
    const result = await integrationStatus({
      env: {
        EVERY_APP_GATEWAY: {
          fetch: async () => new Response(null, { status: 403 }),
        },
      },
      provider: "email",
    });
    expect(result).toEqual({
      requested: false,
      configured: false,
      ready: false,
      sender: null,
      senders: [],
      provider: null,
      settings: [],
      setup: null,
      command: null,
    });
  });

  it("in local dev, is configured by EMAIL_FROM and reads the stand-in senders from .dev.vars", async () => {
    await expect(
      integrationStatus({ env: { EVERYAPP_DEV: "1" }, provider: "email" }),
    ).resolves.toMatchObject({ requested: true, senders: [] });
    const dev = {
      EVERYAPP_DEV: "1",
      EVERYAPP_EMAIL_SENDERS: '["*@mail.example.com"]',
    };
    await expect(
      integrationStatus({ env: dev, provider: "email" }),
    ).resolves.toEqual({
      requested: true,
      configured: false,
      ready: false,
      sender: null,
      senders: ["*@mail.example.com"],
      provider: null,
      settings: ["EMAIL_FROM"],
      setup:
        "Email isn't set up for local development: set EMAIL_FROM in .dev.vars.",
      command: null,
    });
    await expect(
      integrationStatus({
        env: { ...dev, EMAIL_FROM: "EveryApp <noreply@example.com>" },
        provider: "email",
      }),
    ).resolves.toEqual({
      requested: true,
      configured: true,
      ready: true,
      sender: { address: "noreply@example.com", name: "EveryApp" },
      senders: ["*@mail.example.com"],
      // Printed, not sent: no provider is set up.
      provider: null,
      settings: [],
      setup: null,
      command: null,
    });
  });

  it("in local dev, names the provider the gateway would pick from .dev.vars", async () => {
    const provider = async (settings: Record<string, string>) =>
      (
        await integrationStatus({
          env: {
            EVERYAPP_DEV: "1",
            EMAIL_FROM: "EveryApp <noreply@example.com>",
            ...settings,
          },
          provider: "email",
        })
      ).provider;
    const rest = {
      EMAIL_REST_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
    };
    expect(await provider(rest)).toBe("cloudflare");
    expect(await provider({ RESEND_API_KEY: "re_key" })).toBe("resend");
    // Both: Cloudflare first, unless EMAIL_PROVIDER says otherwise.
    expect(await provider({ ...rest, RESEND_API_KEY: "re_key" })).toBe(
      "cloudflare",
    );
    expect(
      await provider({
        ...rest,
        RESEND_API_KEY: "re_key",
        EMAIL_PROVIDER: "Resend",
      }),
    ).toBe("resend");
    // A choice that isn't set up, or isn't a provider, picks none.
    expect(await provider({ ...rest, EMAIL_PROVIDER: "resend" })).toBeNull();
    expect(await provider({ ...rest, EMAIL_PROVIDER: "sendgrid" })).toBeNull();
    // Half the REST pair is no provider.
    expect(await provider({ EMAIL_REST_API_TOKEN: "token" })).toBeNull();
  });
});

describe("OAuth clients", () => {
  const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
  const DEV_CLIENTS = {
    EVERYAPP_DEV: "1",
    GOOGLE_WORKSPACE_CLIENT_ID: "dev-google-id",
    GOOGLE_WORKSPACE_CLIENT_SECRET: "dev-google-secret",
    EVERYAPP_DEV_CAPABILITIES: JSON.stringify({
      "google-workspace": { access: "write", scopes: ["identity"] },
    }),
  };

  function directFetch() {
    const sent = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ access_token: "user-token", scope: "openid email" }),
    );
    vi.stubGlobal("fetch", sent);
    return sent;
  }

  it("sends a token call over the binding with no client, for the gateway to add", async () => {
    const { env, bindingFetch } = bindingEnv();
    const google = integrationFetch({
      env,
      provider: "google-workspace",
      for: new Request("https://crm.example.com/x", {
        headers: { "x-everyapp-identity": "signed-user-identity" },
      }),
    });

    await google(GOOGLE_TOKEN, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic app",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "c",
      }),
    });

    const forwarded = bindingFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "http://every-app-gateway.internal/api/integrations/google-workspace/oauth2.googleapis.com/token",
    );
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("x-everyapp-identity")).toBe(
      "signed-user-identity",
    );
    expect(await forwarded?.text()).toBe(
      "grant_type=authorization_code&code=c",
    );
  });

  it("refuses anything but the provider's token endpoints, before the gateway sees it", async () => {
    const { env, bindingFetch } = bindingEnv();
    const google = integrationFetch({ env, provider: "google-workspace" });
    // Not a token endpoint, and not one of its API hosts either.
    await expect(
      google("https://accounts.google.com/o/oauth2/v2/auth"),
    ).rejects.toThrow(
      /token endpoints \(POST https:\/\/oauth2\.googleapis\.com\/token\)/,
    );
    // The token endpoint, with a method it doesn't take.
    await expect(google(GOOGLE_TOKEN)).rejects.toThrow(TypeError);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("in local dev, puts the developer's client on by the gateway's rule: form", async () => {
    const sent = directFetch();
    await integrationFetch({ env: DEV_CLIENTS, provider: "google-workspace" })(
      GOOGLE_TOKEN,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=r&client_secret=app-secret",
      },
    );
    const request = sent.mock.calls[0]![0];
    expect(request.url).toBe(GOOGLE_TOKEN);
    expect(request.redirect).toBe("manual");
    expect(await request.text()).toBe(
      "grant_type=refresh_token&refresh_token=r&client_id=dev-google-id&client_secret=dev-google-secret",
    );
  });

  it("in local dev, refuses a body it can't put the client in, and one too large", async () => {
    directFetch();
    const google = integrationFetch({
      env: DEV_CLIENTS,
      provider: "google-workspace",
    });
    await expect(
      google(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow(/form-encoded/);
    await expect(
      google(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `code=${"x".repeat(64 * 1024)}`,
      }),
    ).rejects.toThrow(/at most 64 KiB/);
  });

  it("in local dev, needs both of the client's settings", async () => {
    directFetch();
    await expect(
      integrationFetch({
        env: { ...DEV_CLIENTS, GOOGLE_WORKSPACE_CLIENT_SECRET: "" },
        provider: "google-workspace",
      })(GOOGLE_TOKEN, { method: "POST", body: "grant_type=refresh_token" }),
    ).rejects.toThrowError(
      /\.dev\.vars .*set GOOGLE_WORKSPACE_CLIENT_ID, GOOGLE_WORKSPACE_CLIENT_SECRET/,
    );
  });

  it("reads the client id from the gateway's status", async () => {
    const bindingFetch = vi.fn(async () =>
      Response.json({
        capability: "slack",
        requested: true,
        configured: true,
        ready: true,
        clientId: "gateway-slack-id",
      }),
    );
    const status = await integrationStatus({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      provider: "slack",
    });
    expect(status.clientId).toBe("gateway-slack-id");
    expectTypeOf(status.clientId).toEqualTypeOf<string | undefined>();
  });

  it("in local dev, gives the developer's client id once both settings are set", async () => {
    await expect(
      integrationStatus({ env: DEV_CLIENTS, provider: "google-workspace" }),
    ).resolves.toMatchObject({
      requested: true,
      configured: true,
      ready: true,
      clientId: "dev-google-id",
    });
    await expect(
      integrationStatus({
        env: { EVERYAPP_DEV: "1", SLACK_CLIENT_ID: "id" },
        provider: "slack",
      }),
    ).resolves.toMatchObject({
      requested: true,
      configured: false,
      ready: false,
      scopeSets: [],
    });
  });
});

describe("OAuth clients with scope sets", () => {
  const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
  const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
  const CALENDAR = "https://www.googleapis.com/auth/calendar.readonly";
  const CAPABILITIES_VAR = JSON.stringify({
    "google-workspace": { access: "write", scopes: ["identity", "gmail.read"] },
    "microsoft-365": { access: "write", scopes: ["identity", "mail.read"] },
  });
  const DEV = {
    EVERYAPP_DEV: "1",
    GOOGLE_WORKSPACE_CLIENT_ID: "dev-google-id",
    GOOGLE_WORKSPACE_CLIENT_SECRET: "dev-google-secret",
    MICROSOFT_365_CLIENT_ID: "dev-ms-id",
    MICROSOFT_365_CLIENT_SECRET: "dev-ms-secret",
    EVERYAPP_DEV_CAPABILITIES: CAPABILITIES_VAR,
  };
  const FORM = { "content-type": "application/x-www-form-urlencoded" };

  /** The provider's answer, as `fetch` would hand it back. */
  function providerAnswers(body: unknown, init?: ResponseInit) {
    const sent = vi.fn<(request: Request) => Promise<Response>>(async () =>
      typeof body === "string"
        ? new Response(body, init)
        : Response.json(body, init),
    );
    vi.stubGlobal("fetch", sent);
    return sent;
  }

  const exchange = (
    env: Record<string, string>,
    provider: "google-workspace" | "microsoft-365",
    body: string,
    url = provider === "microsoft-365" ? MS_TOKEN : GOOGLE_TOKEN,
  ) =>
    // `it.each` runs outside the organization `it` from inOrganization gives.
    withOrganization(TEST_ORGANIZATION, () =>
      integrationFetch({ env, provider })(url, {
        method: "POST",
        headers: FORM,
        body,
      }),
    );

  it("passes the gateway's status through, scope sets and scopes included", async () => {
    const answered = {
      capability: "google-workspace",
      requested: true,
      configured: true,
      ready: true,
      clientId: "gateway-google-id",
      scopeSets: ["identity", "search-console.read"],
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/webmasters.readonly",
      ],
    };
    const status = await integrationStatus({
      env: {
        EVERY_APP_GATEWAY: { fetch: async () => Response.json(answered) },
      },
      provider: "google-workspace",
    });
    expect(status).toEqual({ ...answered, ...NO_SETUP });
    expectTypeOf(status.scopeSets).toEqualTypeOf<
      readonly string[] | undefined
    >();
    expectTypeOf(status.scopes).toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf(status.userScopes).toEqualTypeOf<
      readonly string[] | undefined
    >();
  });

  it("in local dev, answers the sets the manifest declares and the provider strings they ask for", async () => {
    await expect(
      integrationStatus({ env: DEV, provider: "google-workspace" }),
    ).resolves.toMatchObject({
      requested: true,
      configured: true,
      ready: true,
      clientId: "dev-google-id",
      scopeSets: ["identity", "gmail.read"],
      scopes: ["openid", "email", "profile", GMAIL],
    });
    // Microsoft's end with offline_access, which every declaring app asks for.
    await expect(
      integrationStatus({ env: DEV, provider: "microsoft-365" }),
    ).resolves.toMatchObject({
      requested: true,
      configured: true,
      ready: true,
      clientId: "dev-ms-id",
      scopeSets: ["identity", "mail.read"],
      scopes: ["User.Read", "Mail.Read", "offline_access"],
    });
  });

  it("in local dev, Slack answers the person's user scopes beside the bot's", async () => {
    await expect(
      integrationStatus({
        env: {
          EVERYAPP_DEV: "1",
          SLACK_CLIENT_ID: "dev-slack-id",
          SLACK_CLIENT_SECRET: "dev-slack-secret",
          EVERYAPP_DEV_CAPABILITIES: JSON.stringify({
            slack: {
              access: "write",
              scopes: ["channels.read", "user-channels.manage"],
            },
          }),
        },
        provider: "slack",
      }),
    ).resolves.toMatchObject({
      requested: true,
      configured: true,
      ready: true,
      clientId: "dev-slack-id",
      scopeSets: ["channels.read", "user-channels.manage"],
      scopes: ["channels:read", "groups:read"],
      userScopes: [
        "channels:read",
        "channels:write",
        "groups:read",
        "groups:write",
      ],
    });
    // Listed for writing but without its sets, Slack is configured and not ready, as Google is.
    await expect(
      integrationStatus({
        env: {
          EVERYAPP_DEV: "1",
          SLACK_CLIENT_ID: "dev-slack-id",
          SLACK_CLIENT_SECRET: "dev-slack-secret",
          EVERYAPP_DEV_CAPABILITIES: JSON.stringify({
            slack: { access: "write" },
          }),
        },
        provider: "slack",
      }),
    ).resolves.toMatchObject({
      requested: true,
      configured: true,
      ready: false,
      scopeSets: [],
    });
  });

  it("in local dev, a void grant is not ready and hides the client id, as on the gateway", async () => {
    const voided = {
      requested: true,
      configured: true,
      ready: false,
      scopeSets: [],
    };
    const { EVERYAPP_DEV_CAPABILITIES: _, ...noManifest } = DEV;
    for (const capabilities of [
      undefined,
      "not json",
      JSON.stringify({ "google-workspace": { access: "write" } }),
      JSON.stringify({ "google-workspace": { access: "write", scopes: [] } }),
      JSON.stringify({
        "google-workspace": { access: "write", scopes: ["gmail.write"] },
      }),
    ]) {
      await expect(
        integrationStatus({
          env: capabilities
            ? { ...DEV, EVERYAPP_DEV_CAPABILITIES: capabilities }
            : noManifest,
          provider: "google-workspace",
        }),
        capabilities,
      ).resolves.toMatchObject(voided);
    }
    // Without the client as well: not configured either.
    await expect(
      integrationStatus({
        env: { EVERYAPP_DEV: "1" },
        provider: "google-workspace",
      }),
    ).resolves.toMatchObject({ ...voided, configured: false });
  });

  it("in local dev, tells an app that doesn't list the client nothing, its id included, as on the gateway", async () => {
    for (const capabilities of [
      "{}",
      JSON.stringify({ slack: { access: "write", scopes: ["channels.read"] } }),
    ]) {
      await expect(
        integrationStatus({
          env: { ...DEV, EVERYAPP_DEV_CAPABILITIES: capabilities },
          provider: "google-workspace",
        }),
        capabilities,
      ).resolves.toEqual({
        requested: false,
        configured: false,
        ready: false,
        ...NO_SETUP,
      });
    }
    // Listed for reading: no token-endpoint call (the app-driven flow
    // needs the write grant), but a Gateway-owned connection serves API
    // calls, so the status answers the sets and the connect path.
    await expect(
      integrationStatus({
        env: {
          ...DEV,
          EVERYAPP_DEV_CAPABILITIES: JSON.stringify({
            "google-workspace": { access: "read", scopes: ["identity"] },
          }),
        },
        provider: "google-workspace",
      }),
    ).resolves.toMatchObject({
      requested: true,
      scopeSets: ["identity"],
      flow: "both",
      connectPath: "/connect/google-workspace",
      connection: null,
    });
  });

  it("in local dev, forwards an answer within the grant, dropping Google's scope from the request", async () => {
    const sent = providerAnswers(
      {
        access_token: "ya29.token",
        refresh_token: "1//refresh",
        scope: `openid ${GMAIL} https://www.googleapis.com/auth/userinfo.email`,
        token_type: "Bearer",
      },
      { headers: { "set-cookie": "NID=1", "x-provider": "google" } },
    );
    const response = await exchange(
      DEV,
      "google-workspace",
      `grant_type=authorization_code&code=c&redirect_uri=r&scope=${encodeURIComponent(GMAIL)}`,
    );
    expect(await sent.mock.calls[0]![0].text()).toBe(
      "grant_type=authorization_code&code=c&redirect_uri=r&client_id=dev-google-id&client_secret=dev-google-secret",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-everyapp-error")).toBeNull();
    expect(response.headers.get("x-provider")).toBe("google");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ access_token: "ya29.token" });
  });

  it("in local dev, replaces Microsoft's request scope with the status's and reads its answer's spelling", async () => {
    const sent = providerAnswers({
      access_token: "eyJ.ms",
      scope: "https%3A%2F%2Fgraph.microsoft.com%2Fmail.read User.Read openid",
    });
    const response = await exchange(
      DEV,
      "microsoft-365",
      "grant_type=refresh_token&refresh_token=r&scope=Mail.Read",
    );
    expect(await sent.mock.calls[0]![0].text()).toBe(
      "grant_type=refresh_token&refresh_token=r&client_id=dev-ms-id&client_secret=dev-ms-secret&scope=User.Read+Mail.Read+offline_access",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ access_token: "eyJ.ms" });
  });

  it.each([
    [
      "a client the manifest doesn't list",
      DEV,
      JSON.stringify({ slack: { access: "write", scopes: ["channels.read"] } }),
      "grant_type=authorization_code&code=c",
      GOOGLE_TOKEN,
      [
        403,
        "capability_not_requested",
        /doesn't list Google .* in its capabilities\. Add capabilities: \{ "google-workspace": \{ access: "write" \} \}/,
      ],
    ],
    [
      "a client listed for reading, before its sets are looked at",
      DEV,
      JSON.stringify({
        "google-workspace": { access: "read", scopes: ["identity"] },
      }),
      "grant_type=authorization_code&code=c",
      GOOGLE_TOKEN,
      [403, "capability_not_requested", /doesn't list Google/],
    ],
    [
      "an undeclared grant",
      DEV,
      JSON.stringify({ "google-workspace": { access: "write" } }),
      "grant_type=authorization_code&code=c",
      GOOGLE_TOKEN,
      [
        403,
        "integration_scopes_undeclared",
        /one or more of: identity, gmail\.read/,
      ],
    ],
    [
      "a set this SDK doesn't offer",
      DEV,
      JSON.stringify({
        "google-workspace": {
          access: "write",
          scopes: ["identity", "gmail.write"],
        },
      }),
      "grant_type=authorization_code&code=c",
      GOOGLE_TOKEN,
      [403, "integration_scopes_undeclared", /doesn't offer: gmail\.write/],
    ],
    [
      "no manifest at all",
      (({ EVERYAPP_DEV_CAPABILITIES: _, ...rest }) => rest)(DEV),
      undefined,
      "grant_type=authorization_code&code=c",
      GOOGLE_TOKEN,
      [403, "integration_scopes_undeclared", /EVERYAPP_DEV_CAPABILITIES/],
    ],
    [
      "the client-credentials grant",
      DEV,
      CAPABILITIES_VAR,
      "grant_type=client_credentials",
      GOOGLE_TOKEN,
      [
        403,
        "integration_grant_not_allowed",
        /authorization_code and refresh_token grants only; client_credentials isn't/,
      ],
    ],
    [
      "a request without grant_type",
      DEV,
      CAPABILITIES_VAR,
      "code=c",
      GOOGLE_TOKEN,
      [403, "integration_grant_not_allowed", /a request without grant_type/],
    ],
    [
      "grant_type in the query string",
      DEV,
      CAPABILITIES_VAR,
      "code=c",
      `${GOOGLE_TOKEN}?grant_type=authorization_code`,
      [400, "integration_body_invalid", /not its query string/],
    ],
    [
      "a request scope outside the sets",
      DEV,
      CAPABILITIES_VAR,
      "grant_type=authorization_code&code=c&scope=Mail.Read%20Mail.Send",
      MS_TOKEN,
      [
        403,
        "integration_scope_not_allowed",
        /may ask .* for identity, mail\.read \(User\.Read, Mail\.Read, offline_access\); the request also asks mail\.send/,
      ],
    ],
  ] as const)(
    "in local dev, refuses %s before the provider is called",
    async (_, env, capabilities, body, url, [status, code, message]) => {
      const sent = providerAnswers({ access_token: "never" });
      const response = await exchange(
        capabilities
          ? { ...env, EVERYAPP_DEV_CAPABILITIES: capabilities }
          : env,
        url === MS_TOKEN ? "microsoft-365" : "google-workspace",
        body,
        url,
      );
      expect(sent).not.toHaveBeenCalled();
      expect(response.status).toBe(status);
      expect(response.headers.get("x-everyapp-error")).toBe(code);
      await expect(gatewayRefusal(response.clone())).resolves.toEqual({
        status,
        code,
        message: expect.stringMatching(message),
        ...NO_SETUP,
      });
      expect(await response.json()).toMatchObject({ code });
    },
  );

  it.each([
    [
      "an answer granting scopes outside the sets",
      { access_token: "ya29.wide", scope: `${GMAIL} ${CALENDAR}` },
      {},
      [
        403,
        "integration_scope_exceeded",
        /doesn't declare: .*calendar\.readonly.* It declares identity, gmail\.read/,
      ],
    ],
    [
      "a token without a scope field",
      { access_token: "ya29.unknown", id_token: "eyJ.id" },
      {},
      [502, "integration_scope_unverified", /without saying which scopes/],
    ],
    [
      "an answer that isn't a JSON object",
      "<html>token</html>",
      { headers: { "content-type": "text/html" } },
      [502, "integration_response_invalid", /isn't a token response/],
    ],
    [
      "an answer over the 64 KiB cap",
      JSON.stringify({ access_token: "x".repeat(64 * 1024), scope: GMAIL }),
      { headers: { "content-type": "application/json" } },
      [502, "integration_response_invalid", /isn't a token response/],
    ],
  ] as const)(
    "in local dev, drops %s instead of handing it to the app",
    async (_, answer, init, [status, code, message]) => {
      providerAnswers(answer, init);
      const response = await exchange(
        DEV,
        "google-workspace",
        "grant_type=authorization_code&code=c",
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("x-everyapp-error")).toBe(code);
      const body = await response.text();
      expect(body).not.toContain("ya29.");
      expect(body).not.toContain("eyJ.");
      expect(JSON.parse(body).message).toMatch(message);
    },
  );

  it("in local dev, streams the provider's own errors, and an answer without a token, through untouched", async () => {
    providerAnswers(
      { error: "invalid_grant", error_description: "Bad Request" },
      { status: 400 },
    );
    const refused = await exchange(
      DEV,
      "google-workspace",
      "grant_type=authorization_code&code=stale",
    );
    expect(refused.status).toBe(400);
    expect(refused.headers.get("x-everyapp-error")).toBeNull();
    await expect(refused.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description: "Bad Request",
    });

    providerAnswers({ ok: false, error: "invalid_code" });
    const noToken = await exchange(
      DEV,
      "google-workspace",
      "grant_type=authorization_code&code=c",
    );
    expect(noToken.status).toBe(200);
    expect(noToken.headers.get("x-everyapp-error")).toBeNull();
    await expect(noToken.json()).resolves.toEqual({
      ok: false,
      error: "invalid_code",
    });
  });
});
