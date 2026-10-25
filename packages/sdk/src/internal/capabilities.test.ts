import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  authorizationFor,
  capabilitySettings,
  describeTokenEndpoints,
  integrationProxyPath,
  isAccountWidePath,
  isCapabilityId,
  oauthClientOrigin,
  oauthClientSecretSetCommand,
  parseIntegrationProxyPath,
  serviceRoutePath,
  tokenEndpointFor,
  type ApiKeyAuth,
  type ApiKeyCapability,
  type ApiKeyCapabilityId,
  type Capability,
  type CapabilitySecret,
  type OAuthClientCapability,
  type OAuthClientCapabilityId,
  type OAuthScopeSet,
  type OAuthScopeSetName,
  type ServiceCapabilityId,
} from "./capabilities";
import { requestedScopes, scopeRouteAllows } from "./oauthScopes";

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
    ["an unknown provider", "/api/integrations/github/api.github.com/user"],
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
    "%s sends its key only to https hosts and reads only with read methods",
    (id) => {
      const capability = CAPABILITIES[id];
      expect(capability.hosts.length).toBeGreaterThan(0);
      for (const host of capability.hosts) {
        expect(new URL(`https://${host}`).host).toBe(host);
      }
      expect(capability.access).toContain("read");
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
    expectTypeOf<ApiKeyCapabilityId>().toEqualTypeOf<
      "dataforseo" | "context"
    >();
    expectTypeOf<"linkedin">().toExtend<OAuthClientCapabilityId>();
    expectTypeOf<"LINKEDIN_CLIENT_SECRET">().toExtend<CapabilitySecret>();
    expectTypeOf<"MASTODON_URL">().toExtend<CapabilitySecret>();
    expectTypeOf<"EMAIL_FROM">().toExtend<CapabilitySecret>();
    expectTypeOf<"CLOUDFLARE_ACCOUNT_ID">().toExtend<CapabilitySecret>();
    expectTypeOf<"DATAFORSEO_API_KEY">().toExtend<CapabilitySecret>();
  });

  it("knows only its own ids, the AI providers among them", () => {
    expect(isCapabilityId("dataforseo")).toBe(true);
    expect(isCapabilityId("toString")).toBe(false);
    expect(isCapabilityId("openai")).toBe(true);
    expect(CAPABILITIES.openai.mode).toBe("ai");
  });
});

describe("the OAuth clients", () => {
  const ids = CAPABILITY_IDS.filter(
    (id): id is OAuthClientCapabilityId =>
      CAPABILITIES[id].mode === "oauth_client",
  );
  const client = (id: OAuthClientCapabilityId): OAuthClientCapability =>
    CAPABILITIES[id];
  /** Segments and paths that carry other requests inside, or another API: in no set's routes. */
  const TUNNEL_SEGMENTS = ["batch", "$batch", "beta"];
  const TUNNELS = [
    "/batch/gmail/v1",
    "/batch/calendar/v3",
    "/v1.0/$batch",
    "/beta/me/messages",
    "/beta/me/sendMail",
  ];

  it("are the 16 social networks' clients and the 2 mail and calendar clients, with 37 gateway settings", () => {
    expect(ids).toEqual([
      "linkedin",
      "facebook",
      "instagram",
      "threads",
      "youtube",
      "tiktok",
      "tiktok-business",
      "reddit",
      "pinterest",
      "discord",
      "slack",
      "mastodon",
      "kick",
      "twitch",
      "tumblr",
      "dribbble",
      "google-workspace",
      "microsoft-365",
    ]);
    const settings = ids.flatMap((id) => capabilitySettings(client(id)));
    expect(settings).toHaveLength(37);
    expect(new Set(settings).size).toBe(37);
    expect(capabilitySettings(client("mastodon"))).toEqual([
      "MASTODON_CLIENT_ID",
      "MASTODON_CLIENT_SECRET",
      "MASTODON_URL",
    ]);
    // Postiz's idiosyncratic names, normalised.
    expect(client("slack").secrets).toEqual({
      clientId: "SLACK_CLIENT_ID",
      clientSecret: "SLACK_CLIENT_SECRET",
    });
    expect(client("kick").secrets.clientSecret).toBe("KICK_CLIENT_SECRET");
  });

  it.each(ids)(
    "%s completes exact https token endpoints only, for writing",
    (id) => {
      const capability = client(id);
      expect(capability.access).toEqual(["write"]);
      expect(capability.token.length).toBeGreaterThan(0);
      for (const endpoint of capability.token) {
        if (endpoint.host === undefined) {
          expect(capability.hostSetting).toBeTruthy();
        } else {
          // A bare lowercase host: no scheme, port, path or credentials.
          expect(new URL(`https://${endpoint.host}`).host).toBe(endpoint.host);
          expect(endpoint.host).toMatch(/^[a-z0-9.-]+$/);
        }
        if (typeof endpoint.path === "string") {
          expect(new URL(`https://x${endpoint.path}`).pathname).toBe(
            endpoint.path,
          );
        } else {
          // Anchored at both ends, and stateless.
          expect(endpoint.path.source).toMatch(/^\^\\\/.*\$$/);
          expect(endpoint.path.flags).toBe("");
        }
        expect(endpoint.methods.length).toBeGreaterThan(0);
        if (endpoint.inject === "form" || endpoint.inject === "json") {
          // The client goes in a body: never on a GET.
          expect(endpoint.methods).toEqual(["POST"]);
        }
      }
      // The operator's checklist: https URLs, or paths on the instance.
      const onInstance = (url: string) =>
        capability.hostSetting ? url.startsWith("/") : false;
      for (const url of [capability.authorize.url, capability.console]) {
        expect(onInstance(url) || new URL(url).protocol === "https:", url).toBe(
          true,
        );
      }
      expect(capability.authorize.scopes.length).toBeGreaterThan(0);
      expect(capability.redirectPaths.length).toBeGreaterThan(0);
      for (const path of capability.redirectPaths) {
        expect(path).toMatch(/^\/integrations(?:\/[a-z-]+)+\/?$/);
      }
    },
  );

  const policyIds = ids.filter((id) => client(id).scopePolicy);

  it.each(policyIds)(
    "%s holds its scope sets to the design's invariants",
    (id) => {
      const capability = client(id);
      const policy = capability.scopePolicy!;
      // The boundary at the token endpoint exists because the app never
      // holds the secret; with a public client it could exchange codes
      // itself.
      expect(capability.secrets.clientSecret).toBeDefined();
      // The two grants the gateway completes, spelled as `tokenGrantType()`
      // reads them: a typo here would refuse every exchange. Slack's code
      // exchange (`oauth.v2.access`) carries no `grant_type` at all.
      expect(policy.grantTypes).toEqual(
        policy.dialect === "slack"
          ? [null, "refresh_token"]
          : ["authorization_code", "refresh_token"],
      );
      for (const scope of policy.alwaysRequested) {
        expect(policy.tolerated).toContain(scope);
      }
      const names = Object.keys(policy.sets);
      expect(names.length).toBeGreaterThan(0);
      // The operator's checklist is the sets' union, nothing more or less.
      const union = requestedScopes(policy, names);
      expect([...capability.authorize.scopes].sort()).toEqual(
        [...new Set([...union.scopes, ...union.userScopes])].sort(),
      );
      expect(new Set(capability.authorize.scopes).size).toBe(
        capability.authorize.scopes.length,
      );
      // Never a tunnel, and never one of the policy's own denied segments:
      // the route allowlist refuses those first, so the route would be dead.
      const denied = [
        ...TUNNEL_SEGMENTS,
        ...policy.deniedSegments.map((segment) => segment.toLowerCase()),
      ];
      /** The token endpoints on `host`: Slack's API shares its token host, so the rule is per path. */
      const tokenPaths = (host: string) =>
        capability.token.flatMap((endpoint) =>
          endpoint.host === host && typeof endpoint.path === "string"
            ? [endpoint.path]
            : [],
        );
      for (const [name, set] of Object.entries(policy.sets)) {
        expect(name).toMatch(/^(identity|[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)$/);
        expect(set.label).toBeTruthy();
        expect(["read", "write"]).toContain(set.access);
        expect(
          set.scopes.length + (set.userScopes?.length ?? 0),
          name,
        ).toBeGreaterThan(0);
        expect(set.routes.length, name).toBeGreaterThan(0);
        for (const route of set.routes) {
          // A bare https host the docs list as an API host, never the
          // token host.
          expect(new URL(`https://${route.host}`).host).toBe(route.host);
          expect(route.host).toMatch(/^[a-z0-9.-]+$/);
          expect(capability.api).toContain(route.host);
          // Never the token endpoint itself, by exact path, prefix or POST
          // pattern: the gateway completes that with the client on it.
          for (const tokenPath of tokenPaths(route.host)) {
            for (const verb of ["GET", "POST"]) {
              expect(
                scopeRouteAllows(
                  policy,
                  [name],
                  verb,
                  new URL(`https://${route.host}${tokenPath}`),
                ),
                `${name} ${verb} ${tokenPath}`,
              ).toBeNull();
            }
          }
          for (const path of route.paths) {
            // Plain raw paths: nothing encoded, no doubled separator.
            expect(path, `${name} ${path}`).toMatch(/^\/[^%\\]*$/);
            expect(path).not.toContain("//");
            for (const segment of path.split("/")) {
              expect(denied, `${name} ${path}`).not.toContain(
                segment.toLowerCase(),
              );
            }
            // And the allowlist agrees: the set unlocks what it declares.
            expect(
              scopeRouteAllows(
                policy,
                [name],
                "GET",
                new URL(`https://${route.host}${path}`),
              ),
              `${name} ${path}`,
            ).toBe(name);
          }
          for (const pattern of route.posts ?? []) {
            // Anchored at both ends, and stateless.
            expect(pattern.source).toMatch(/^\^\\\/.*\$$/);
            expect(pattern.flags).toBe("");
            for (const tunnel of TUNNELS) {
              expect(pattern.test(tunnel), `${pattern} ${tunnel}`).toBe(false);
            }
            // Each literal segment of the pattern (between escaped slashes,
            // unescaped) is compared like a path's.
            for (const fragment of pattern.source.slice(1, -1).split("\\/")) {
              expect(denied, `${name} ${pattern}`).not.toContain(
                fragment.replace(/\\(.)/g, "$1").toLowerCase(),
              );
            }
          }
        }
      }
    },
  );

  it("offer scope sets on slack and the shared Google and Microsoft clients, every Google and Microsoft set read-only", () => {
    expect(ids.filter((id) => client(id).scopePolicy)).toEqual([
      "slack",
      "google-workspace",
      "microsoft-365",
    ]);
    const google = CAPABILITIES["google-workspace"].scopePolicy;
    const microsoft = CAPABILITIES["microsoft-365"].scopePolicy;
    expect(Object.keys(google.sets)).toEqual([
      "identity",
      "gmail.read",
      "calendar.read",
      "search-console.read",
      "analytics.read",
    ]);
    expect(Object.keys(microsoft.sets)).toEqual([
      "identity",
      "mail.read",
      "calendar.read",
    ]);
    // A deployed manifest is a grant the app declared for itself, so a
    // write set on these two shared clients is a registry change to
    // review, not a name to add here. Slack's sets are writes by nature
    // (posting is the point) and are pinned one by one below.
    for (const policy of [google, microsoft]) {
      for (const [name, set] of Object.entries(policy.sets)) {
        expect(set.access, name).toBe("read");
      }
    }
    // The token host is not an API host.
    expect(client("google-workspace").api).not.toContain(
      "oauth2.googleapis.com",
    );
    expectTypeOf<OAuthScopeSetName<"google-workspace">>().toEqualTypeOf<
      | "identity"
      | "gmail.read"
      | "calendar.read"
      | "search-console.read"
      | "analytics.read"
    >();
    expectTypeOf<OAuthScopeSetName<"microsoft-365">>().toEqualTypeOf<
      "identity" | "mail.read" | "calendar.read"
    >();
    // Over a union of ids, every name either offers, not the shared ones.
    expectTypeOf<
      OAuthScopeSetName<"google-workspace" | "microsoft-365">
    >().toEqualTypeOf<
      | "identity"
      | "gmail.read"
      | "calendar.read"
      | "search-console.read"
      | "analytics.read"
      | "identity"
      | "mail.read"
      | "calendar.read"
    >();
    expectTypeOf<OAuthScopeSetName<"linkedin">>().toEqualTypeOf<never>();
  });

  it("slack: the sets cover Postiz's and Open CRM's requests and nothing else, each unlocking its methods by name", () => {
    const slack = CAPABILITIES.slack;
    const policy = slack.scopePolicy;
    expect(policy.dialect).toBe("slack");
    expect(policy.requestScope).toBe("keep");
    expect(policy.alwaysRequested).toEqual([]);
    expect(policy.tolerated).toEqual([]);
    expect(policy.deniedSegments).toEqual([]);
    // Set, access, bot scopes, user scopes, read methods (GET and POST),
    // write methods (POST only).
    const table: ReadonlyArray<
      [
        OAuthScopeSetName<"slack">,
        "read" | "write",
        string[],
        string[],
        string[],
        string[],
      ]
    > = [
      [
        "channels.read",
        "read",
        ["channels:read", "groups:read"],
        [],
        [
          "conversations.list",
          "conversations.info",
          "conversations.members",
          "users.conversations",
        ],
        [],
      ],
      [
        "users.read",
        "read",
        ["users:read"],
        [],
        ["users.list", "users.info", "users.getPresence", "bots.info"],
        [],
      ],
      [
        "users.email",
        "read",
        ["users:read.email"],
        [],
        ["users.lookupByEmail"],
        [],
      ],
      [
        "messages.write",
        "write",
        ["chat:write", "chat:write.public", "chat:write.customize"],
        [],
        ["chat.scheduledMessages.list"],
        [
          "chat.postMessage",
          "chat.postEphemeral",
          "chat.update",
          "chat.delete",
          "chat.scheduleMessage",
          "chat.deleteScheduledMessage",
        ],
      ],
      [
        "channels.join",
        "write",
        ["channels:join"],
        [],
        [],
        ["conversations.join"],
      ],
      [
        "channels.manage",
        "write",
        [
          "channels:manage",
          "groups:write",
          "channels:write.invites",
          "groups:write.invites",
          "im:write",
        ],
        [],
        [],
        [
          "conversations.create",
          "conversations.rename",
          "conversations.archive",
          "conversations.unarchive",
          "conversations.invite",
          "conversations.open",
          "conversations.kick",
          "conversations.leave",
          "conversations.setTopic",
          "conversations.setPurpose",
          "conversations.mark",
        ],
      ],
      [
        "files.write",
        "write",
        ["files:write"],
        [],
        [],
        ["files.getUploadURLExternal", "files.completeUploadExternal"],
      ],
      [
        "user-channels.manage",
        "write",
        [],
        ["channels:read", "channels:write", "groups:read", "groups:write"],
        [
          "conversations.list",
          "conversations.info",
          "conversations.members",
          "users.conversations",
        ],
        [
          "conversations.create",
          "conversations.rename",
          "conversations.archive",
          "conversations.unarchive",
          "conversations.invite",
          "conversations.kick",
          "conversations.leave",
          "conversations.setTopic",
          "conversations.setPurpose",
          "conversations.mark",
        ],
      ],
    ];
    expect(Object.keys(policy.sets)).toEqual(table.map(([name]) => name));
    const url = (method: string) => new URL(`https://slack.com/api/${method}`);
    for (const [name, access, scopes, userScopes, reads, writes] of table) {
      const set: OAuthScopeSet = policy.sets[name];
      expect(set.access, name).toBe(access);
      expect(set.scopes, name).toEqual(scopes);
      expect(set.userScopes ?? [], name).toEqual(userScopes);
      for (const method of reads) {
        for (const verb of ["GET", "POST"]) {
          expect(
            scopeRouteAllows(policy, [name], verb, url(method)),
            `${name} ${verb} ${method}`,
          ).toBe(name);
        }
      }
      for (const method of writes) {
        expect(
          scopeRouteAllows(policy, [name], "POST", url(method)),
          `${name} POST ${method}`,
        ).toBe(name);
        expect(
          scopeRouteAllows(policy, [name], "GET", url(method)),
          `${name} GET ${method}`,
        ).toBeNull();
      }
    }
    // A method no set names, the retired upload, and the token endpoint on
    // the same host stay refused whatever an app declares.
    const every = Object.keys(policy.sets);
    for (const method of [
      "conversations.history",
      "files.upload",
      "auth.revoke",
      "oauth.v2.access",
    ]) {
      for (const verb of ["GET", "POST"]) {
        expect(
          scopeRouteAllows(policy, every, verb, url(method)),
          `${verb} ${method}`,
        ).toBeNull();
      }
    }
    // What each consumer sends today is within what its sets ask for.
    const postiz = requestedScopes(policy, [
      "channels.read",
      "users.read",
      "messages.write",
      "channels.join",
      "files.write",
    ]);
    for (const scope of [
      "channels:read",
      "chat:write",
      "users:read",
      "groups:read",
      "channels:join",
      "chat:write.customize",
      "files:write",
    ]) {
      expect(postiz.scopes).toContain(scope);
    }
    expect(postiz.userScopes).toEqual([]);
    const openCrm = requestedScopes(policy, [
      "channels.read",
      "users.read",
      "users.email",
      "messages.write",
      "channels.join",
      "channels.manage",
      "user-channels.manage",
    ]);
    for (const scope of [
      "users:read",
      "users:read.email",
      "channels:read",
      "groups:read",
      "chat:write",
      "chat:write.public",
      "im:write",
      "channels:join",
      "channels:manage",
      "groups:write",
      "channels:write.invites",
      "groups:write.invites",
    ]) {
      expect(openCrm.scopes).toContain(scope);
    }
    expect(openCrm.userScopes).toEqual([
      "channels:read",
      "channels:write",
      "groups:read",
      "groups:write",
    ]);
    // The operator's checklist in set order, bot scopes then the one user
    // scope no bot set carries; the four scopes nobody asks for are gone.
    expect(slack.authorize.scopes).toEqual([
      "channels:read",
      "groups:read",
      "users:read",
      "users:read.email",
      "chat:write",
      "chat:write.public",
      "chat:write.customize",
      "channels:join",
      "channels:manage",
      "groups:write",
      "channels:write.invites",
      "groups:write.invites",
      "im:write",
      "files:write",
      "channels:write",
    ]);
    for (const scope of [
      "channels:history",
      "groups:history",
      "conversations.connect:write",
      "links:write",
    ]) {
      expect(slack.authorize.scopes).not.toContain(scope);
    }
    expectTypeOf<OAuthScopeSetName<"slack">>().toEqualTypeOf<
      | "channels.read"
      | "users.read"
      | "users.email"
      | "messages.write"
      | "channels.join"
      | "channels.manage"
      | "files.write"
      | "user-channels.manage"
    >();
  });

  it("names the command that gives the gateway each client", () => {
    expect(oauthClientSecretSetCommand(client("linkedin"))).toBe(
      "pnpm everyapp secret set LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET",
    );
    expect(oauthClientSecretSetCommand(client("mastodon"))).toBe(
      "pnpm everyapp secret set MASTODON_CLIENT_ID MASTODON_CLIENT_SECRET MASTODON_URL",
    );
    expect(describeTokenEndpoints(client("facebook"))).toBe(
      "GET/POST https://graph.facebook.com/v<version>/oauth/access_token",
    );
    expect(describeTokenEndpoints(client("mastodon"))).toBe(
      "POST https://<MASTODON_URL>/oauth/token",
    );
  });
});

describe("OAuth client paths", () => {
  /** What the gateway makes of an app's call to `url` through `provider`. */
  const parse = (
    provider: OAuthClientCapabilityId,
    url: string,
    settings?: Record<string, string>,
  ) => {
    const path = new URL(
      integrationProxyPath(provider, new URL(url)),
      "http://gateway.internal",
    );
    return parseIntegrationProxyPath(path.pathname, path.search, settings);
  };

  it.each<[OAuthClientCapabilityId, string]>([
    ["linkedin", "https://www.linkedin.com/oauth/v2/accessToken"],
    ["facebook", "https://graph.facebook.com/v25.0/oauth/access_token?code=x"],
    ["facebook", "https://graph.facebook.com/v19.0/oauth/access_token"],
    ["instagram", "https://api.instagram.com/oauth/access_token"],
    ["instagram", "https://graph.instagram.com/access_token?grant_type=x"],
    ["threads", "https://graph.threads.net/oauth/access_token"],
    ["threads", "https://graph.threads.net/access_token"],
    ["youtube", "https://oauth2.googleapis.com/token"],
    ["tiktok", "https://open.tiktokapis.com/v2/oauth/token/"],
    [
      "tiktok-business",
      "https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/",
    ],
    ["reddit", "https://www.reddit.com/api/v1/access_token"],
    ["pinterest", "https://api.pinterest.com/v5/oauth/token"],
    ["discord", "https://discord.com/api/oauth2/token"],
    ["slack", "https://slack.com/api/oauth.v2.access"],
    ["mastodon", "https://mastodon.social/oauth/token"],
    ["kick", "https://id.kick.com/oauth/token"],
    ["twitch", "https://id.twitch.tv/oauth2/token"],
    ["tumblr", "https://api.tumblr.com/v2/oauth2/token"],
    ["dribbble", "https://dribbble.com/oauth/token?code=x"],
    ["google-workspace", "https://oauth2.googleapis.com/token"],
    [
      "microsoft-365",
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    ],
  ])("%s takes %s", (provider, url) => {
    const route = parse(provider, url);
    expect(route).toMatchObject({
      kind: "oauth_client",
      id: provider,
      upstream: new URL(url),
    });
  });

  it.each<[OAuthClientCapabilityId, string]>([
    // The API, on the token host or its own: the app calls it directly.
    ["linkedin", "https://api.linkedin.com/v2/me"],
    ["linkedin", "https://www.linkedin.com/oauth/v2/authorization"],
    ["facebook", "https://graph.facebook.com/v25.0/me/accounts"],
    ["slack", "https://slack.com/api/chat.postMessage"],
    ["discord", "https://discord.com/api/channels/1/messages"],
    // Near misses: unversioned, a trailing slash, another case, an encoding.
    ["facebook", "https://graph.facebook.com/oauth/access_token"],
    ["facebook", "https://graph.facebook.com/v25/oauth/access_token"],
    ["linkedin", "https://www.linkedin.com/oauth/v2/accessToken/"],
    ["linkedin", "https://www.linkedin.com/oauth/v2/accesstoken"],
    ["linkedin", "https://www.linkedin.com/oauth/v2/%61ccessToken"],
    ["tiktok", "https://open.tiktokapis.com/v2/oauth/token"],
    // Another client's endpoint.
    ["reddit", "https://www.linkedin.com/oauth/v2/accessToken"],
    // Another instance than the operator's.
    ["mastodon", "https://evil.example/oauth/token"],
  ])("%s refuses %s", (provider, url) => {
    expect(parse(provider, url)).toBeNull();
  });

  it("finds Mastodon's token endpoint on the instance MASTODON_URL names", () => {
    const fosstodon = parse("mastodon", "https://fosstodon.org/oauth/token", {
      MASTODON_URL: "https://fosstodon.org/",
    });
    expect(fosstodon).toMatchObject({ kind: "oauth_client", id: "mastodon" });
    // The default instance is no longer the operator's.
    expect(
      parse("mastodon", "https://mastodon.social/oauth/token", {
        MASTODON_URL: "fosstodon.org",
      }),
    ).toBeNull();
  });

  it("reads MASTODON_URL as an https origin, mastodon.social when unset", () => {
    const mastodon: OAuthClientCapability = CAPABILITIES.mastodon;
    const origin = (value?: string) =>
      oauthClientOrigin(mastodon, { MASTODON_URL: value });
    expect(origin()).toBe("https://mastodon.social");
    expect(origin("  ")).toBe("https://mastodon.social");
    expect(origin("https://fosstodon.org")).toBe("https://fosstodon.org");
    expect(origin("https://Fosstodon.org/")).toBe("https://fosstodon.org");
    expect(origin("fosstodon.org")).toBe("https://fosstodon.org");
    expect(origin("https://social.example:8443")).toBe(
      "https://social.example:8443",
    );
    for (const bad of [
      "http://fosstodon.org",
      "https://fosstodon.org/mastodon",
      "https://fosstodon.org/?x=1",
      "https://user:pass@fosstodon.org",
      "ftp://fosstodon.org",
      "https://",
    ]) {
      expect(origin(bad), bad).toBeNull();
    }
    // A client with a fixed host has no origin to resolve.
    expect(oauthClientOrigin(CAPABILITIES.linkedin, {})).toBeNull();
  });

  it("matches an endpoint by host and path, never by scheme or method", () => {
    const linkedin: OAuthClientCapability = CAPABILITIES.linkedin;
    expect(
      tokenEndpointFor(
        linkedin,
        new URL("http://www.linkedin.com/oauth/v2/accessToken"),
        {},
      ),
    ).toBeNull();
    expect(
      tokenEndpointFor(
        linkedin,
        new URL("https://www.linkedin.com/oauth/v2/accessToken?x=1"),
        {},
      ),
    ).toMatchObject({ inject: "form", methods: ["POST"] });
  });
});
