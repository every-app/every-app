import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  authSettingNames,
  authorizationFor,
  capabilitySettings,
  integrationProxyPath,
  isAccountWidePath,
  isCapabilityId,
  CATALOG,
  parseIntegrationProxyPath,
  serviceRoutePath,
  type AiProviderId,
  type ApiKeyAuth,
  type ApiKeyCapability,
  type ApiKeyCapabilityId,
  type Capability,
  type CapabilitySecret,
  type ServiceCapabilityId,
} from "./capabilities";
import { withOAuthPresets } from "./oauthPresets";
import { isInstallOwnedGatewaySetting } from "./gatewaySettings";
import { providerSettingPrefix } from "./providerRegistry";

describe("integration proxy paths", () => {
  it("round-trips a provider URL", () => {
    const upstream = new URL(
      "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/abc?x=1",
    );
    const url = new URL(
      integrationProxyPath("dataforseo", upstream),
      "http://gateway.internal",
    );

    expect(parseIntegrationProxyPath(url.pathname, url.search)).toEqual({
      kind: "api_key",
      id: "dataforseo",
      capability: CAPABILITIES.dataforseo,
      upstream,
    });
  });

  it("names a service capability's declared route", () => {
    expect(serviceRoutePath("email", "send")).toBe(
      "/api/integrations/email/send",
    );
    const route = {
      kind: "service",
      id: "email",
      capability: CAPABILITIES.email,
      route: "send",
    };
    expect(
      parseIntegrationProxyPath("/api/integrations/email/send", ""),
    ).toEqual(route);
    // A query string doesn't change the route.
    expect(
      parseIntegrationProxyPath("/api/integrations/email/send", "?x=1"),
    ).toEqual(route);
  });

  it("never routes an AI provider: its route is /api/ai, and a key that reached its host would reach the account", () => {
    expect(
      parseIntegrationProxyPath(
        "/api/integrations/openrouter/openrouter.ai/api/v1/credits",
        "",
      ),
    ).toBeNull();
  });

  it("takes the host a provider's hostSetting names, when it is one host", () => {
    const shopify: ApiKeyCapability = {
      mode: "api_key",
      label: "Shopify",
      auth: {
        kind: "header",
        secret: "SHOPIFY_API_KEY",
        header: "X-Shopify-Access-Token",
      },
      docs: "https://shopify.dev/",
      hosts: [],
      hostSetting: "SHOPIFY_HOST",
      access: ["read"],
      readMethods: ["GET"],
      accountWidePaths: [],
    };
    const lookup = {
      get: (id: string) => (id === "shopify" ? shopify : undefined),
      ids: () => ["shopify"],
    };
    const path =
      "/api/integrations/shopify/acme.myshopify.com/admin/api/2024-10/orders.json";
    const hostFor = (setting: string | undefined) => {
      const route = parseIntegrationProxyPath(
        path,
        "",
        { SHOPIFY_HOST: setting },
        lookup,
      );
      return route?.kind === "api_key" ? route.upstream.host : null;
    };
    expect(hostFor("https://acme.myshopify.com")).toBe("acme.myshopify.com");
    expect(hostFor("ACME.myshopify.com")).toBe("acme.myshopify.com");
    for (const bad of [
      undefined,
      "",
      "https://acme.myshopify.com/admin",
      "https://acme.myshopify.com:8443",
      "http://acme.myshopify.com",
      "https://user@acme.myshopify.com",
      "other.myshopify.com",
    ]) {
      expect(hostFor(bad)).toBeNull();
    }
    expect(capabilitySettings(shopify)).toEqual([
      "SHOPIFY_API_KEY",
      "SHOPIFY_HOST",
    ]);
  });

  it.each([
    ["a route email doesn't declare", "/api/integrations/email/other"],
    ["a path under the route", "/api/integrations/email/send/more"],
    ["a trailing slash", "/api/integrations/email/send/"],
    ["an inherited property", "/api/integrations/email/toString"],
    ["a host-shaped route", "/api/integrations/email/api.cloudflare.com/x"],
  ])("refuses %s", (_name, pathname) => {
    expect(parseIntegrationProxyPath(pathname, "")).toBeNull();
  });

  it.each([
    ["an unknown provider", "/api/integrations/nope/api.nope.example/user"],
    [
      "a host outside the provider's",
      "/api/integrations/dataforseo/evil.example/v3/x",
    ],
    [
      "a host with a port",
      "/api/integrations/dataforseo/api.dataforseo.com:8443/v3/x",
    ],
    [
      "a protocol-relative path",
      "/api/integrations/dataforseo/api.dataforseo.com//evil.example/x",
    ],
  ])("rejects %s", (_name, pathname) => {
    expect(parseIntegrationProxyPath(pathname, "")).toBeNull();
  });
});

describe("DataForSEO's account-wide paths", () => {
  /** The pathname the gateway checks: what the URL parser leaves of `path`. */
  const accountWide = (path: string) =>
    isAccountWidePath(
      CAPABILITIES.dataforseo,
      new URL(`https://api.dataforseo.com${path}`).pathname,
    );

  it.each([
    "/v3/serp/google/organic/tasks_ready",
    "/v3/dataforseo_labs/id_list",
    "/v3/appendix/errors",
    "/v3/appendix/user_data",
    "/v3/appendix/webhook_resend",
    // A suffix on the segment: whitespace, NUL, a comma, raw or encoded.
    "/v3/serp/google/organic/tasks_ready%20",
    "/v3/serp/google/organic/tasks_ready%00",
    "/v3/serp/google/organic/tasks_ready,",
    "/v3/serp/google/organic/tasks_ready%2C",
    "/v3/serp/google/organic/tasks_ready%2c/advanced",
    "/v3/serp/id_list;x",
    "/v3/serp/id_list.json",
    "/v3/serp/id_list%09",
    "/v3/serp/id_list%E2%80%8B",
    // Encoded, twice-encoded or in another case.
    "/v3/serp/google/organic/tasks%5Fready",
    "/v3/serp/google/organic/tasks%255Fready",
    "/v3/serp/google/organic/TASKS_READY",
    // Case folding outside ASCII is the provider's: ſ is an s to some.
    "/v3/serp/google/organic/ta%C5%BFks_ready",
    // The multi-segment ones, split or suffixed.
    "/v3/appendix%2Fuser_data",
    "/v3/appendix//user_data",
    "/v3/appendix%5Cwebhook_resend",
    "/v3/APPENDIX/user_data%20",
    "/v3/appendix;x/webhook_resend,",
    // A dot segment only decoding reveals.
    "/v3/serp/google/organic/tasks_fixed",
    "/v3/serp/tasks_ready/%252e%252e",
    // Won't decode, or won't stop decoding.
    "/v3/serp/%E0%A4%A",
    "/v3/serp/google/organic/%2525252574asks_ready",
  ])("refuses %s", (path) => {
    expect(accountWide(path)).toBe(true);
  });

  it.each([
    "/v3/serp/google/organic/task_get/advanced/09271234-1535-0066-0000-5c2f2a1f8d10",
    "/v3/serp/google/organic/task_post",
    "/v3/serp/google/organic/live/advanced",
    "/v3/dataforseo_labs/google/keyword_ideas/live",
    "/v3/appendix/status",
    "/v3/appendix/user_data_example",
    "/v3/user_data",
    "/v3/serp/google/locations/us",
  ])("serves %s", (path) => {
    expect(accountWide(path)).toBe(false);
  });

  it("refuses whitespace and control characters for providers without account-wide paths too", () => {
    expect(isAccountWidePath(CAPABILITIES.context, "/v1/scrape")).toBe(false);
    expect(isAccountWidePath(CAPABILITIES.context, "/v1/scrape%0A")).toBe(true);
  });
});

describe("DataForSEO credentials", () => {
  const authorization = (key: string) =>
    authorizationFor(CAPABILITIES.dataforseo, { DATAFORSEO_API_KEY: key })
      ?.headers["authorization"];

  it("encodes a login:password key", () => {
    expect(authorization("me@example.com:secret")).toBe(
      `Basic ${btoa("me@example.com:secret")}`,
    );
  });

  it("keeps a key that is already base64", () => {
    expect(authorization(` ${btoa("me@example.com:secret")} `)).toBe(
      `Basic ${btoa("me@example.com:secret")}`,
    );
  });

  it("is unset while the setting is blank", () => {
    expect(authorization("  ")).toBeUndefined();
  });
});

describe("Context.dev credentials", () => {
  it("sends the key as a bearer token", () => {
    expect(
      authorizationFor(CAPABILITIES.context, { CONTEXT_API_KEY: " ctx_key " }),
    ).toEqual({ headers: { authorization: "Bearer ctx_key" }, query: {} });
  });
});

describe("the auth kinds", () => {
  const provider = (auth: ApiKeyAuth): ApiKeyCapability => ({
    mode: "api_key",
    label: "Example",
    auth,
    docs: "https://example.com/keys",
    hosts: ["api.example.com"],
    access: ["read"],
    readMethods: ["GET"],
    accountWidePaths: [],
  });

  it("bearer takes a scheme", () => {
    expect(
      authorizationFor(
        provider({
          kind: "bearer",
          secret: "EXAMPLE_API_KEY",
          scheme: "Token",
        }),
        { EXAMPLE_API_KEY: "k" },
      ),
    ).toEqual({ headers: { authorization: "Token k" }, query: {} });
  });

  it("header puts the key in a named header, with its prefix, lower-cased", () => {
    expect(
      authorizationFor(
        provider({
          kind: "header",
          secret: "EXAMPLE_API_KEY",
          header: "X-Api-Key",
        }),
        { EXAMPLE_API_KEY: "k" },
      ),
    ).toEqual({ headers: { "x-api-key": "k" }, query: {} });
    expect(
      authorizationFor(
        provider({
          kind: "header",
          secret: "EXAMPLE_API_KEY",
          header: "Authorization",
          prefix: "Klaviyo-API-Key ",
        }),
        { EXAMPLE_API_KEY: "k" },
      ),
    ).toEqual({ headers: { authorization: "Klaviyo-API-Key k" }, query: {} });
  });

  it("query puts the key in a query parameter", () => {
    expect(
      authorizationFor(
        provider({ kind: "query", secret: "EXAMPLE_API_KEY", param: "appid" }),
        { EXAMPLE_API_KEY: "k" },
      ),
    ).toEqual({ headers: {}, query: { appid: "k" } });
  });

  it("basic says where the key goes: the password beside a user, the username, or the pair", () => {
    expect(
      authorizationFor(
        provider({
          kind: "basic",
          secret: "EXAMPLE_API_KEY",
          as: "password",
          user: "api",
        }),
        { EXAMPLE_API_KEY: "k" },
      ),
    ).toEqual({
      headers: { authorization: `Basic ${btoa("api:k")}` },
      query: {},
    });
    expect(
      authorizationFor(
        provider({ kind: "basic", secret: "EXAMPLE_API_KEY", as: "username" }),
        { EXAMPLE_API_KEY: "k" },
      ),
    ).toEqual({ headers: { authorization: `Basic ${btoa("k:")}` }, query: {} });
    // A bare key under `pair` is taken as already encoded: the catalog's rule for DataForSEO alone.
    expect(
      authorizationFor(
        provider({ kind: "basic", secret: "EXAMPLE_API_KEY", as: "pair" }),
        { EXAMPLE_API_KEY: "a:b" },
      ),
    ).toEqual({
      headers: { authorization: `Basic ${btoa("a:b")}` },
      query: {},
    });
    const twilio = provider({
      kind: "basic",
      secret: "EXAMPLE_AUTH_TOKEN",
      as: "password",
      user: { secret: "EXAMPLE_ACCOUNT_SID" },
    });
    expect(
      authorizationFor(twilio, {
        EXAMPLE_AUTH_TOKEN: "t",
        EXAMPLE_ACCOUNT_SID: "AC1",
      }),
    ).toEqual({
      headers: { authorization: `Basic ${btoa("AC1:t")}` },
      query: {},
    });
    // Both settings are needed.
    expect(authorizationFor(twilio, { EXAMPLE_AUTH_TOKEN: "t" })).toBeNull();
    expect(capabilitySettings(twilio)).toEqual([
      "EXAMPLE_AUTH_TOKEN",
      "EXAMPLE_ACCOUNT_SID",
    ]);
  });
});

describe("the capability registry", () => {
  const apiKeyIds = CAPABILITY_IDS.filter(
    (id): id is ApiKeyCapabilityId => CAPABILITIES[id].mode === "api_key",
  );

  it.each(apiKeyIds)(
    "%s sends its key only to https hosts (or the one its host setting names) and reads only with read methods",
    (id) => {
      const capability: ApiKeyCapability = CAPABILITIES[id];
      // A fixed host, or a host setting the operator fills (Shopify's store).
      expect(
        capability.hosts.length > 0 || capability.hostSetting !== undefined,
      ).toBe(true);
      for (const host of capability.hosts) {
        expect(new URL(`https://${host}`).host).toBe(host);
      }
      expect(capability.access.length).toBeGreaterThan(0);
      // Write-only providers (senders, GraphQL APIs) read with nothing.
      if (capability.access.includes("read")) {
        expect(capability.readMethods.length).toBeGreaterThan(0);
      } else {
        expect(capability.readMethods).toEqual([]);
        expect(capability.writeMethods).toEqual(["POST"]);
      }
      expect(capability.readMethods).not.toContain("DELETE");
    },
  );

  it("offers email as a service the gateway performs, write only", () => {
    const email: Capability = CAPABILITIES.email;
    expect(email).toMatchObject({
      mode: "service",
      access: ["write"],
      routes: { send: ["POST"] },
    });
    expect(capabilitySettings(email)).toEqual([
      "EMAIL_FROM",
      "EMAIL_FROM_NAME",
      "EMAIL_REST_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "RESEND_API_KEY",
      "EMAIL_PROVIDER",
    ]);
    expect(capabilitySettings(CAPABILITIES.dataforseo)).toEqual([
      "DATAFORSEO_API_KEY",
    ]);
    // The types follow the kinds.
    expectTypeOf<ServiceCapabilityId>().toEqualTypeOf<"email" | "members">();
    expectTypeOf<
      "dataforseo" | "context" | "stripe" | "exa"
    >().toExtend<ApiKeyCapabilityId>();
    expectTypeOf<"openai" | "anthropic" | "gemini">().toExtend<AiProviderId>();
    // @ts-expect-error an OAuth provider is a preset, not a catalog capability
    expectTypeOf<"slack">().toExtend<ApiKeyCapabilityId>();
    // The OAuth providers are presets: no gateway reserves their names.
    // @ts-expect-error not a catalog setting
    expectTypeOf<"SLACK_CLIENT_SECRET">().toExtend<CapabilitySecret>();
    expectTypeOf<"EMAIL_FROM">().toExtend<CapabilitySecret>();
    expectTypeOf<"CLOUDFLARE_ACCOUNT_ID">().toExtend<CapabilitySecret>();
    expectTypeOf<"DATAFORSEO_API_KEY">().toExtend<CapabilitySecret>();
    // A Basic username held as a setting is a Gateway setting too.
    expectTypeOf<
      "TWILIO_API_KEY" | "CRISP_API_IDENTIFIER"
    >().toExtend<CapabilitySecret>();
  });

  it("names every API-key and AI provider's settings after its id, so a row can never take a catalog name and the catalog never takes the install's", () => {
    for (const id of CAPABILITY_IDS) {
      const capability: Capability = CAPABILITIES[id];
      if (capability.mode !== "api_key" && capability.mode !== "ai") continue;
      const prefix = providerSettingPrefix(id);
      const own = [
        ...authSettingNames(capability.auth),
        ...(capability.mode === "api_key" && capability.hostSetting
          ? [capability.hostSetting]
          : []),
      ];
      for (const name of own) {
        expect(name.startsWith(prefix), `${id}: ${name} under ${prefix}`).toBe(
          true,
        );
        expect(isInstallOwnedGatewaySetting(name), `${id}: ${name}`).toBe(
          false,
        );
      }
      // What the URL also needs is the install's (Workers AI's account id)
      // or the provider's own (AI Gateway's id), never another's key.
      for (const name of capability.mode === "ai"
        ? (capability.alsoNeeds ?? [])
        : []) {
        expect(
          isInstallOwnedGatewaySetting(name) || name.startsWith(prefix),
          `${id}: ${name}`,
        ).toBe(true);
      }
      // Every catalog provider says where it was checked, or that it wasn't.
      expect(capability.verified, `${id}: verified`).toBeDefined();
      expect(capability.docs.startsWith("https://"), `${id}: docs`).toBe(true);
    }
  });

  it("knows only its own ids, the AI providers among them", () => {
    expect(isCapabilityId("dataforseo")).toBe(true);
    expect(isCapabilityId("toString")).toBe(false);
    expect(isCapabilityId("openai")).toBe(true);
    expect(CAPABILITIES.openai.mode).toBe("ai");
  });
});

describe("the OAuth providers", () => {
  it("are none of the catalog's: each is a registered row, from a preset or a spec", () => {
    expect(
      CAPABILITY_IDS.filter(
        (id) => (CAPABILITIES[id] as Capability).mode === "oauth_client",
      ),
    ).toEqual([]);
  });
});

describe("OAuth provider paths", () => {
  /** What the gateway makes of an app's call to `url` through `provider`, its preset registered. */
  const parse = (provider: string, url: string) => {
    const path = new URL(
      integrationProxyPath(provider, new URL(url)),
      "http://gateway.internal",
    );
    return parseIntegrationProxyPath(
      path.pathname,
      path.search,
      undefined,
      withOAuthPresets(CATALOG),
    );
  };

  it.each<[string, string]>([
    ["google-workspace", "https://gmail.googleapis.com/gmail/v1/users/me"],
    [
      "google-workspace",
      "https://searchconsole.googleapis.com/webmasters/v3/sites?x=1",
    ],
    ["slack", "https://slack.com/api/chat.postMessage"],
    ["microsoft-365", "https://graph.microsoft.com/v1.0/me/messages"],
  ])("%s takes a call to its API: %s", (provider, url) => {
    expect(parse(provider, url)).toMatchObject({
      kind: "oauth_client",
      id: provider,
      upstream: new URL(url),
    });
  });

  it.each<[string, string]>([
    // The token and authorize endpoints are the Gateway's alone.
    ["google-workspace", "https://oauth2.googleapis.com/token"],
    ["google-workspace", "https://accounts.google.com/o/oauth2/v2/auth"],
    [
      "microsoft-365",
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ],
    // Another provider's host.
    ["slack", "https://gmail.googleapis.com/gmail/v1/users/me"],
    ["google-workspace", "https://attacker.example/x"],
  ])("%s refuses %s", (provider, url) => {
    expect(parse(provider, url)).toBeNull();
  });

  it("refuses a path that could leave the host", () => {
    expect(
      parseIntegrationProxyPath(
        "/api/integrations/google-workspace/gmail.googleapis.com//attacker.example/x",
        "",
      ),
    ).toBeNull();
    expect(
      parseIntegrationProxyPath(
        "/api/integrations/google-workspace/gmail.googleapis.com/a\\b",
        "",
      ),
    ).toBeNull();
  });
});

describe("the Daytona entry", () => {
  const daytona = CAPABILITIES.daytona;

  it("is an account-wide bearer key on Daytona's API host, read and write", () => {
    expect(daytona.mode).toBe("api_key");
    expect(daytona.auth).toEqual({ kind: "bearer", secret: "DAYTONA_API_KEY" });
    expect(daytona.hosts).toEqual(["app.daytona.io"]);
    // Served on a self-hosted Gateway only.
    expect(daytona.data).toBe("account");
    expect(daytona.access).toEqual(["read", "write"]);
    expect(
      authorizationFor(daytona, { DAYTONA_API_KEY: "k" })?.headers[
        "authorization"
      ],
    ).toBe("Bearer k");
  });

  const accountWide = (path: string) =>
    isAccountWidePath(
      daytona,
      new URL(`https://app.daytona.io${path}`).pathname,
    );

  it.each([
    "/api/organizations",
    "/api/organizations/org-1/users",
    "/api/sandbox/sbx-1/organization",
    "/api/billing",
    "/api/api-keys/current",
    "/api/users/me",
    "/api/audit/organizations/org-1",
    "/api/webhooks/organizations/org-1/app-portal-access",
    "/api/secret/s-1",
    "/api/docker-registry",
    "/api/object-storage/push-access",
    "/api/regions/r-1/regenerate-ssh-gateway-api-key",
    "/api/runners/me",
    "/api/sandbox/for-runner",
    "/api/jobs",
    "/api/warm-pools/w-1",
    "/api/preview/sbx-1/access",
    "/api/sandbox/ssh-access/validate",
  ])("refuses %s", (path) => {
    expect(accountWide(path)).toBe(true);
  });

  it.each([
    "/api/sandbox",
    "/api/sandbox/sbx-1/stop",
    "/api/sandbox/sbx-1/secrets",
    "/api/sandbox/sbx-1/ssh-access",
    "/api/sandbox/sbx-1/ports/3000/signed-preview-url",
    "/api/snapshots/s-1/activate",
    "/api/volumes",
    "/api/shared-regions",
  ])("serves %s", (path) => {
    expect(accountWide(path)).toBe(false);
  });
});
