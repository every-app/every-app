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

  it("refuses a capability the gateway doesn't offer, deployed or in local dev", async () => {
    const bindingFetch = vi.fn(async () => Response.json({}));
    for (const env of [
      { EVERY_APP_GATEWAY: { fetch: bindingFetch } },
      { EVERYAPP_DEV: "1" },
    ]) {
      await expect(
        integrationStatus({ env, provider: "toString" as "dataforseo" }),
      ).rejects.toThrowError(ConfigurationError);
    }
    expect(bindingFetch).not.toHaveBeenCalled();
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
        // @ts-expect-error email is a service, not a provider with a key.
        provider: "email",
      }),
    ).toThrow(
      new ConfigurationError(
        "email is sent with sendEmail() from @every-app/sdk/server, not integrationFetch().",
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

  it("in local dev, is configured by EMAIL_FROM and reads the manifest's senders", async () => {
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
    ).resolves.toEqual({ requested: true, configured: false, ready: false });
  });
});
