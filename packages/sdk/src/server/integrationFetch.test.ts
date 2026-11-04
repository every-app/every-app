import { afterEach, describe, expect, expectTypeOf, vi } from "vitest";
import { TEST_ORGANIZATION, it } from "../../test/inOrganization";
import { serveRequest, withOrganization } from "./context";
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

describe("OAuth providers", () => {
  const IDENTITY = "x-everyapp-identity";
  const USER = "x-everyapp-user";
  const person = () =>
    new Request("https://seo.example.com/_serverFn/x", {
      headers: { [IDENTITY]: "signed-viewer-identity" },
    });
  const viewer = {
    id: "user_viewer",
    email: "viewer@example.com",
    orgId: TEST_ORGANIZATION,
  } as never;

  it("sends a call to the provider's API over the binding with the person's identity and no credentials", async () => {
    const { env, bindingFetch } = bindingEnv();
    const gmail = integrationFetch({
      env,
      provider: "google-workspace",
      for: person(),
    });
    await gmail(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread",
      {
        headers: {
          authorization: "Bearer app-token",
          cookie: "a=b",
          "x-everyapp-account": "organization",
          [USER]: "app-set",
        },
      },
    );
    const forwarded = bindingFetch.mock.calls[0]![0];
    expect(forwarded.url).toBe(
      "http://every-app-gateway.internal/api/integrations/google-workspace/gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread",
    );
    expect(forwarded.headers.get(IDENTITY)).toBe("signed-viewer-identity");
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get(USER)).toBeNull();
  });

  it("leaves the host to the gateway, which holds the provider's row, and reaches https only", async () => {
    const { env, bindingFetch } = bindingEnv();
    const google = integrationFetch({ env, provider: "google-workspace" });
    await expect(
      google("http://gmail.googleapis.com/gmail/v1/users/me/profile"),
    ).rejects.toThrow(TypeError);
    expect(bindingFetch).not.toHaveBeenCalled();
    await google("https://oauth2.googleapis.com/token", { method: "POST" });
    expect(
      new URL((bindingFetch.mock.calls[0]?.[0] as Request).url).pathname,
    ).toBe("/api/integrations/google-workspace/oauth2.googleapis.com/token");
  });

  it("names a member's connection with for: { background: true, userId }, never the person being served, even mid-request", async () => {
    const { env, bindingFetch } = bindingEnv();
    const served = { request: person(), user: viewer, expiresAt: null };
    await serveRequest(served, async () => {
      // The person being served: their own connection.
      await integrationFetch({ env, provider: "google-workspace" })(
        "https://searchconsole.googleapis.com/webmasters/v3/sites",
      );
      // The member who picked the property: theirs, whoever is viewing.
      await integrationFetch({
        env,
        provider: "google-workspace",
        for: { background: true, userId: "user_owner" },
      })("https://searchconsole.googleapis.com/webmasters/v3/sites", {
        headers: { [IDENTITY]: "app-supplied", [USER]: "someone-else" },
      });
    });
    const [own, named] = bindingFetch.mock.calls.map(([request]) => request);
    expect(own!.headers.get(IDENTITY)).toBe("signed-viewer-identity");
    expect(own!.headers.get(USER)).toBeNull();
    expect(named!.headers.get(USER)).toBe("user_owner");
    expect(named!.headers.get(IDENTITY)).toBeNull();
    expect(() =>
      integrationFetch({
        env,
        provider: "google-workspace",
        for: { background: true, userId: " " },
      }),
    ).toThrow(/non-empty user id/);
  });

  describe("in local dev", () => {
    const devEnv = (extra: Record<string, string> = {}) => ({
      EVERYAPP_DEV: "1",
      EVERYAPP_APP_ID: "openseo",
      EVERYAPP_DEV_CAPABILITIES: JSON.stringify({
        "google-workspace": {
          scopes: ["webmasters.readonly", "analytics.readonly"],
          why: "Reads Search Console and Analytics.",
        },
      }),
      ...extra,
    });

    it("puts the developer's token on a call to an API host, stripping what the gateway strips", async () => {
      const sent = vi.fn<(request: Request) => Promise<Response>>(async () =>
        Response.json({ siteEntry: [] }),
      );
      vi.stubGlobal("fetch", sent);
      const google = integrationFetch({
        env: devEnv({ GOOGLE_WORKSPACE_ACCESS_TOKEN: "ya29.dev" }),
        provider: "google-workspace",
        for: { background: true, userId: "user_owner" },
      });
      const response = await google(
        "https://searchconsole.googleapis.com/webmasters/v3/sites?access_token=x&token=y&keep=1",
        {
          method: "POST",
          body: "{}",
          headers: {
            authorization: "Bearer mine",
            "x-http-method-override": "DELETE",
          },
        },
      );
      expect(response.status).toBe(200);
      const request = sent.mock.calls[0]![0];
      expect(request.url).toBe(
        "https://searchconsole.googleapis.com/webmasters/v3/sites?keep=1",
      );
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer ya29.dev");
      expect(request.headers.get("x-http-method-override")).toBeNull();
      expect(request.headers.get(USER)).toBeNull();
      expect(request.redirect).toBe("manual");
      // Hosts are still enforced.
      await expect(
        google("https://oauth2.googleapis.com/token", { method: "POST" }),
      ).rejects.toThrow(TypeError);
      expect(sent).toHaveBeenCalledTimes(1);
    });

    it("answers the gateway's not-connected refusal without a token, optional or not", async () => {
      const sent = vi.fn<(request: Request) => Promise<Response>>(async () =>
        Response.json({}),
      );
      vi.stubGlobal("fetch", sent);
      const google = integrationFetch({
        env: devEnv(),
        provider: "google-workspace",
        optional: true,
      });
      expect(google).not.toBeNull();
      const response = await google!(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      );
      expect(response.status).toBe(409);
      await expect(gatewayRefusal(response)).resolves.toMatchObject({
        code: "integration_not_connected",
        message: expect.stringMatching(/GOOGLE_WORKSPACE_ACCESS_TOKEN/),
      });
      const body = await (
        await google!("https://gmail.googleapis.com/gmail/v1/users/me/profile")
      ).json();
      expect(body).toMatchObject({
        error: "Conflict",
        connectPath: "/connect/google-workspace?app=openseo",
        reconnect: false,
      });
      expect(sent).not.toHaveBeenCalled();
    });
  });

  describe("status", () => {
    it("passes the gateway's status through", async () => {
      const gateway = {
        requested: true,
        configured: true,
        ready: false,
        scopes: ["gmail.modify", "gmail.send"],
        connectPath: "/connect/google-workspace?app=openmail",
        connection: {
          label: "ben@example.com",
          scopes: ["gmail.modify"],
          ready: false,
          missingScopes: ["gmail.send"],
          reconnect: true,
        },
        ...NO_SETUP,
      };
      const bindingFetch = vi.fn(async () => Response.json(gateway));
      const status = await integrationStatus({
        env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
        provider: "google-workspace",
        for: { background: true, userId: "user_owner" },
      });
      expect(status).toEqual(gateway);
      expectTypeOf(status.scopes).toEqualTypeOf<readonly string[]>();
      expectTypeOf(status.connectPath).toEqualTypeOf<string | null>();
      expectTypeOf(status.connection).toEqualTypeOf<{
        label: string | null;
        scopes: readonly string[];
        ready: boolean;
        missingScopes?: readonly string[];
        reconnect?: true;
      } | null>();
      // Whose: the member background work names.
      const [, init] = bindingFetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(new Headers(init.headers).get(USER)).toBe("user_owner");
    });

    it("is unavailable, with no connection, when the gateway refuses the status call", async () => {
      const bindingFetch = vi.fn(async () =>
        Response.json({}, { status: 403 }),
      );
      await expect(
        integrationStatus({
          env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
          provider: "google-workspace",
        }),
      ).resolves.toEqual({
        requested: false,
        configured: false,
        ready: false,
        scopes: [],
        connectPath: null,
        connection: null,
        ...NO_SETUP,
      });
    });

    const devEnv = (extra: Record<string, string> = {}) => ({
      EVERYAPP_DEV: "1",
      EVERYAPP_APP_ID: "openmail",
      EVERYAPP_DEV_CAPABILITIES: JSON.stringify({
        "google-workspace": {
          scopes: ["gmail.modify", "gmail.send"],
          why: "Mirrors your Gmail.",
        },
      }),
      ...extra,
    });

    it("in local dev, a token in .dev.vars stands for a connection holding the declared scopes", async () => {
      await expect(
        integrationStatus({
          env: devEnv({ GOOGLE_WORKSPACE_ACCESS_TOKEN: "ya29.dev" }),
          provider: "google-workspace",
        }),
      ).resolves.toEqual({
        requested: true,
        configured: true,
        ready: true,
        scopes: ["gmail.modify", "gmail.send"],
        connectPath: "/connect/google-workspace?app=openmail",
        connection: {
          label: null,
          scopes: ["gmail.modify", "gmail.send"],
          ready: true,
        },
        ...NO_SETUP,
      });
    });

    it("in local dev, without a token, says which one to set", async () => {
      await expect(
        integrationStatus({ env: devEnv(), provider: "google-workspace" }),
      ).resolves.toEqual({
        requested: true,
        configured: false,
        ready: false,
        scopes: ["gmail.modify", "gmail.send"],
        connectPath: "/connect/google-workspace?app=openmail",
        connection: null,
        settings: ["GOOGLE_WORKSPACE_ACCESS_TOKEN"],
        setup: expect.stringMatching(
          /GOOGLE_WORKSPACE_ACCESS_TOKEN in \.dev\.vars/,
        ),
        command: null,
      });
    });

    it("in local dev, tells an app that doesn't list the provider nothing", async () => {
      await expect(
        integrationStatus({
          env: devEnv({ GOOGLE_WORKSPACE_ACCESS_TOKEN: "ya29.dev" }),
          provider: "slack",
        }),
      ).resolves.toEqual({
        requested: false,
        configured: false,
        ready: false,
        scopes: [],
        connectPath: null,
        connection: null,
        ...NO_SETUP,
      });
    });
  });
});
