import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
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
    const call = integrationFetch({ env, provider: "stripe" });
    await call("https://api.stripe.com/v1/customers?limit=1", {
      headers: { authorization: "Bearer app-key" },
    });
    const forwarded = bindingFetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe(
      "http://every-app-gateway.internal/api/integrations/stripe/api.stripe.com/v1/customers?limit=1",
    );
    expect(forwarded.headers.get("authorization")).toBeNull();
    await expect(
      call("http://api.stripe.com/v1/customers"),
    ).rejects.toThrowError(/https URLs only/);
    expect(() =>
      integrationFetch({ env: { EVERYAPP_DEV: "1" }, provider: "stripe" }),
    ).toThrowError(/isn't in the built-in provider catalog/);
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

  it("asks the gateway about a provider outside the catalog, and refuses one in local dev", async () => {
    // Deployed: the gateway's registry may have it; a refusal reads as unavailable.
    const bindingFetch = vi.fn(async () =>
      Response.json({ error: "not found" }, { status: 400 }),
    );
    await expect(
      integrationStatus({
        env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
        provider: "stripe",
      }),
    ).resolves.toEqual({ requested: false, configured: false, ready: false });
    expect(bindingFetch).toHaveBeenCalledWith(
      "http://every-app-gateway.internal/api/integrations/stripe",
    );
    // Local dev knows the catalog only.
    await expect(
      integrationStatus({ env: { EVERYAPP_DEV: "1" }, provider: "stripe" }),
    ).rejects.toThrowError(ConfigurationError);
    await expect(
      integrationStatus({ env: { EVERYAPP_DEV: "1" }, provider: "openai" }),
    ).rejects.toThrowError(/is an AI provider/);
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
      sender: { address: "noreply@example.com", name: "Every App" },
      senders: ["*@mail.example.com"],
      provider: "resend",
    };
    const bindingFetch = vi.fn(async () => Response.json(status));
    const result = await integrationStatus({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      provider: "email",
    });
    expect(result).toEqual(status);
    expectTypeOf(result.senders).toEqualTypeOf<string[]>();
    expectTypeOf(result.provider).toEqualTypeOf<
      "cloudflare" | "resend" | null
    >();
    expect(bindingFetch).toHaveBeenCalledWith(
      "http://every-app-gateway.internal/api/integrations/email",
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
    });
    await expect(
      integrationStatus({
        env: { ...dev, EMAIL_FROM: "Every App <noreply@example.com>" },
        provider: "email",
      }),
    ).resolves.toEqual({
      requested: true,
      configured: true,
      ready: true,
      sender: { address: "noreply@example.com", name: "Every App" },
      senders: ["*@mail.example.com"],
      // Printed, not sent: no provider is set up.
      provider: null,
    });
  });

  it("in local dev, names the provider the gateway would pick from .dev.vars", async () => {
    const provider = async (settings: Record<string, string>) =>
      (
        await integrationStatus({
          env: {
            EVERYAPP_DEV: "1",
            EMAIL_FROM: "Every App <noreply@example.com>",
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
  const LINKEDIN_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
  const DEV_CLIENTS = {
    EVERYAPP_DEV: "1",
    LINKEDIN_CLIENT_ID: "dev-linkedin-id",
    LINKEDIN_CLIENT_SECRET: "dev-linkedin-secret",
    REDDIT_CLIENT_ID: "dev-reddit-id",
    REDDIT_CLIENT_SECRET: "dev-reddit-secret",
    FACEBOOK_APP_ID: "dev-facebook-id",
    FACEBOOK_APP_SECRET: "dev-facebook-secret",
    TIKTOK_BUSINESS_CLIENT_ID: "dev-tiktok-id",
    TIKTOK_BUSINESS_CLIENT_SECRET: "dev-tiktok-secret",
    MASTODON_CLIENT_ID: "dev-mastodon-id",
    MASTODON_CLIENT_SECRET: "dev-mastodon-secret",
    MASTODON_URL: "https://fosstodon.org",
  };

  function directFetch() {
    const sent = vi.fn<(request: Request) => Promise<Response>>(async () =>
      Response.json({ access_token: "user-token" }),
    );
    vi.stubGlobal("fetch", sent);
    return sent;
  }

  it("sends a token call over the binding with no client, for the gateway to add", async () => {
    const { env, bindingFetch } = bindingEnv();
    const linkedin = integrationFetch({
      env,
      provider: "linkedin",
      for: new Request("https://postiz.example.com/x", {
        headers: { "x-everyapp-identity": "signed-user-identity" },
      }),
    });

    await linkedin(LINKEDIN_TOKEN, {
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
      "http://every-app-gateway.internal/api/integrations/linkedin/www.linkedin.com/oauth/v2/accessToken",
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
    const linkedin = integrationFetch({ env, provider: "linkedin" });
    await expect(linkedin("https://api.linkedin.com/v2/me")).rejects.toThrow(
      /only reaches LinkedIn's token endpoints \(POST https:\/\/www\.linkedin\.com\/oauth\/v2\/accessToken\)/,
    );
    // The token endpoint, with a method it doesn't take.
    await expect(linkedin(LINKEDIN_TOKEN)).rejects.toThrow(TypeError);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("leaves the instance of a provider with none fixed to the gateway", async () => {
    const { env, bindingFetch } = bindingEnv();
    await integrationFetch({ env, provider: "mastodon" })(
      "https://fosstodon.org/oauth/token",
      { method: "POST", body: "" },
    );
    expect(bindingFetch.mock.calls[0]?.[0].url).toBe(
      "http://every-app-gateway.internal/api/integrations/mastodon/fosstodon.org/oauth/token",
    );
  });

  it("in local dev, puts the developer's client on by the gateway's rule: form", async () => {
    const sent = directFetch();
    await integrationFetch({ env: DEV_CLIENTS, provider: "linkedin" })(
      LINKEDIN_TOKEN,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token&refresh_token=r&client_secret=app-secret",
      },
    );
    const request = sent.mock.calls[0]![0];
    expect(request.url).toBe(LINKEDIN_TOKEN);
    expect(request.redirect).toBe("manual");
    expect(await request.text()).toBe(
      "grant_type=refresh_token&refresh_token=r&client_id=dev-linkedin-id&client_secret=dev-linkedin-secret",
    );
  });

  it("in local dev: basic, query and json", async () => {
    const sent = directFetch();
    await integrationFetch({ env: DEV_CLIENTS, provider: "reddit" })(
      "https://www.reddit.com/api/v1/access_token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=c",
      },
    );
    await integrationFetch({ env: DEV_CLIENTS, provider: "facebook" })(
      "https://graph.facebook.com/v25.0/oauth/access_token?code=c",
    );
    await integrationFetch({ env: DEV_CLIENTS, provider: "tiktok-business" })(
      "https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          auth_code: "c",
        }),
      },
    );
    const [reddit, facebook, tiktok] = sent.mock.calls.map(([r]) => r);
    expect(reddit?.headers.get("authorization")).toBe(
      `Basic ${btoa("dev-reddit-id:dev-reddit-secret")}`,
    );
    expect(await reddit?.text()).toBe("grant_type=authorization_code&code=c");
    expect(facebook?.method).toBe("GET");
    expect(facebook?.url).toBe(
      "https://graph.facebook.com/v25.0/oauth/access_token?code=c&client_id=dev-facebook-id&client_secret=dev-facebook-secret",
    );
    expect(JSON.parse(await tiktok!.text())).toEqual({
      grant_type: "authorization_code",
      auth_code: "c",
      client_id: "dev-tiktok-id",
      client_secret: "dev-tiktok-secret",
    });
  });

  it("in local dev, reaches the instance MASTODON_URL names and no other", async () => {
    const sent = directFetch();
    const mastodon = integrationFetch({
      env: DEV_CLIENTS,
      provider: "mastodon",
    });
    await mastodon("https://fosstodon.org/oauth/token", {
      method: "POST",
      body: "",
    });
    expect(sent.mock.calls[0]?.[0].url).toBe(
      "https://fosstodon.org/oauth/token",
    );
    await expect(
      mastodon("https://mastodon.social/oauth/token", { method: "POST" }),
    ).rejects.toThrow(TypeError);
  });

  it("in local dev, refuses a body it can't put the client in, and one too large", async () => {
    directFetch();
    const linkedin = integrationFetch({
      env: DEV_CLIENTS,
      provider: "linkedin",
    });
    await expect(
      linkedin(LINKEDIN_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow(/form-encoded/);
    await expect(
      linkedin(LINKEDIN_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `code=${"x".repeat(64 * 1024)}`,
      }),
    ).rejects.toThrow(/at most 64 KiB/);
  });

  it("in local dev, needs both of the client's settings", () => {
    expect(() =>
      integrationFetch({
        env: { EVERYAPP_DEV: "1", LINKEDIN_CLIENT_ID: "id" },
        provider: "linkedin",
      }),
    ).toThrowError(
      /set LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET in \.dev\.vars/,
    );
  });

  it("reads the client id (and instance) from the gateway's status", async () => {
    const bindingFetch = vi.fn(async () =>
      Response.json({
        capability: "linkedin",
        requested: true,
        configured: true,
        ready: true,
        clientId: "gateway-linkedin-id",
      }),
    );
    const status = await integrationStatus({
      env: { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      provider: "linkedin",
    });
    expect(status.clientId).toBe("gateway-linkedin-id");
    expectTypeOf(status.clientId).toEqualTypeOf<string | undefined>();
    expectTypeOf(status.origin).toEqualTypeOf<string | undefined>();
  });

  it("in local dev, gives the developer's client id once both settings are set", async () => {
    await expect(
      integrationStatus({ env: DEV_CLIENTS, provider: "linkedin" }),
    ).resolves.toEqual({
      requested: true,
      configured: true,
      ready: true,
      clientId: "dev-linkedin-id",
    });
    await expect(
      integrationStatus({ env: DEV_CLIENTS, provider: "mastodon" }),
    ).resolves.toEqual({
      requested: true,
      configured: true,
      ready: true,
      clientId: "dev-mastodon-id",
      origin: "https://fosstodon.org",
    });
    await expect(
      integrationStatus({
        env: { EVERYAPP_DEV: "1", SLACK_CLIENT_ID: "id" },
        provider: "slack",
      }),
    ).resolves.toEqual({
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
    linkedin: { access: "write" },
  });
  const DEV = {
    EVERYAPP_DEV: "1",
    GOOGLE_WORKSPACE_CLIENT_ID: "dev-google-id",
    GOOGLE_WORKSPACE_CLIENT_SECRET: "dev-google-secret",
    MICROSOFT_365_CLIENT_ID: "dev-ms-id",
    MICROSOFT_365_CLIENT_SECRET: "dev-ms-secret",
    LINKEDIN_CLIENT_ID: "dev-linkedin-id",
    LINKEDIN_CLIENT_SECRET: "dev-linkedin-secret",
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
    provider: "google-workspace" | "microsoft-365" | "linkedin",
    body: string,
    url = provider === "microsoft-365" ? MS_TOKEN : GOOGLE_TOKEN,
  ) =>
    integrationFetch({ env, provider })(url, {
      method: "POST",
      headers: FORM,
      body,
    });

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
    expect(status).toEqual(answered);
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
    ).resolves.toEqual({
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
    ).resolves.toEqual({
      requested: true,
      configured: true,
      ready: true,
      clientId: "dev-ms-id",
      scopeSets: ["identity", "mail.read"],
      scopes: ["User.Read", "Mail.Read", "offline_access"],
    });
    // A client without scope sets answers as before.
    await expect(
      integrationStatus({ env: DEV, provider: "linkedin" }),
    ).resolves.toEqual({
      requested: true,
      configured: true,
      ready: true,
      clientId: "dev-linkedin-id",
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
    ).resolves.toEqual({
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
    ).resolves.toEqual({
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
      ).resolves.toEqual(voided);
    }
    // Without the client as well: not configured either.
    await expect(
      integrationStatus({
        env: { EVERYAPP_DEV: "1" },
        provider: "google-workspace",
      }),
    ).resolves.toEqual({ ...voided, configured: false });
    // LinkedIn has no sets to void.
    await expect(
      integrationStatus({ env: noManifest, provider: "linkedin" }),
    ).resolves.toMatchObject({ ready: true, clientId: "dev-linkedin-id" });
  });

  it("in local dev, tells an app that doesn't list the client nothing, its id included, as on the gateway", async () => {
    for (const capabilities of [
      "{}",
      JSON.stringify({ linkedin: { access: "write" } }),
      JSON.stringify({
        "google-workspace": { access: "read", scopes: ["identity"] },
      }),
    ]) {
      await expect(
        integrationStatus({
          env: { ...DEV, EVERYAPP_DEV_CAPABILITIES: capabilities },
          provider: "google-workspace",
        }),
        capabilities,
      ).resolves.toEqual({ requested: false, configured: false, ready: false });
    }
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
      JSON.stringify({ linkedin: { access: "write" } }),
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

  it("in local dev, leaves a client without scope sets as it was: any grant, any answer", async () => {
    const sent = providerAnswers({ access_token: "linkedin-token" });
    const response = await exchange(
      DEV,
      "linkedin",
      "grant_type=client_credentials",
      "https://www.linkedin.com/oauth/v2/accessToken?grant_type=client_credentials",
    );
    expect(sent).toHaveBeenCalledOnce();
    expect(response.headers.get("x-everyapp-error")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      access_token: "linkedin-token",
    });
  });
});
