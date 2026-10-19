import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
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
  type ApiKeyCapabilityId,
  type Capability,
  type CapabilitySecret,
  type OAuthClientCapability,
  type OAuthClientCapabilityId,
  type ServiceCapabilityId,
} from "./capabilities";

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
      upstream,
    });
  });

  it("names a service capability's declared route", () => {
    expect(serviceRoutePath("email", "send")).toBe(
      "/api/integrations/email/send",
    );
    expect(
      parseIntegrationProxyPath("/api/integrations/email/send", ""),
    ).toEqual({ kind: "service", id: "email", route: "send" });
    // A query string doesn't change the route.
    expect(
      parseIntegrationProxyPath("/api/integrations/email/send", "?x=1"),
    ).toEqual({ kind: "service", id: "email", route: "send" });
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
    "/v3/serp/google/organic/tasks_fixed",
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
  const { authorization } = CAPABILITIES.dataforseo;

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
});

describe("Context.dev credentials", () => {
  it("sends the key as a bearer token", () => {
    expect(CAPABILITIES.context.authorization(" ctx_key ")).toBe(
      "Bearer ctx_key",
    );
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
    expectTypeOf<ServiceCapabilityId>().toEqualTypeOf<"email">();
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

  it("knows only its own ids", () => {
    expect(isCapabilityId("dataforseo")).toBe(true);
    expect(isCapabilityId("toString")).toBe(false);
    expect(isCapabilityId("openai")).toBe(false);
  });
});

describe("the OAuth clients", () => {
  const ids = CAPABILITY_IDS.filter(
    (id): id is OAuthClientCapabilityId =>
      CAPABILITIES[id].mode === "oauth_client",
  );
  const client = (id: OAuthClientCapabilityId): OAuthClientCapability =>
    CAPABILITIES[id];

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

  it("names the command that gives the gateway each client", () => {
    expect(oauthClientSecretSetCommand(client("linkedin"))).toBe(
      "pnpm everyapp secret set LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET --for gateway",
    );
    expect(oauthClientSecretSetCommand(client("mastodon"))).toBe(
      "pnpm everyapp secret set MASTODON_CLIENT_ID MASTODON_CLIENT_SECRET MASTODON_URL --for gateway",
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
