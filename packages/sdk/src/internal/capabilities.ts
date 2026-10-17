/**
 * Capabilities the gateway holds for apps (docs/capabilities.md), of three
 * kinds:
 *
 *  - `api_key`: a provider whose key the gateway holds. The operator sets
 *    the key once on the gateway (`everyapp secret set <secret> --for
 *    gateway`), an app lists the provider in its manifest's `capabilities`,
 *    and the app calls the provider through the AppGateway binding
 *    (`integrationFetch()`), so no app ever holds the key.
 *  - `oauth_client`: a provider's OAuth client (a social network's), held
 *    the same way. The gateway completes the token endpoint calls only,
 *    putting the client on them; the app builds the authorize URL from the
 *    public client id (`integrationStatus()`), keeps the user tokens and
 *    calls the provider's API with them itself.
 *  - `service`: something the gateway does itself, with no upstream host
 *    an app names (sending email). An app lists it the same way and calls
 *    its routes, `/api/integrations/<id>/<route>`, through the SDK's own
 *    helper (`sendEmail()`).
 *
 * The gateway enforces these definitions, the manifest validator checks
 * `capabilities` against them, and the SDK reads them for its local-dev
 * fallback, which calls the provider directly with a developer's own key.
 * All three import them from here so they cannot drift.
 */

/** What an app may ask to do with a capability. */
export type CapabilityAccess = "read" | "write";

export interface ApiKeyCapability {
  mode: "api_key";
  /** The provider's name in errors and logs. */
  label: string;
  /** The gateway secret holding the key; in local dev, the `.dev.vars` name. */
  secret: string;
  /** The only hosts the key is ever sent to, always over https. */
  hosts: readonly string[];
  /** The access levels the provider offers; the manifest may ask for these only. */
  access: readonly CapabilityAccess[];
  /** Methods an app asking for `access: "read"` may use. */
  readMethods: readonly string[];
  /**
   * Paths no app may reach, each as its run of path segments, refused
   * wherever those segments appear together in the upstream path however
   * it is spelled (see {@link isAccountWidePath}). One key serves every app
   * in every organization, so endpoints that list or describe the whole
   * provider account would show one app another's work.
   */
  accountWidePaths: readonly (readonly string[])[];
  /** The Authorization header value for a configured key. */
  authorization(key: string): string;
}

/**
 * A capability the gateway performs itself, with no upstream host:
 * reached at `/api/integrations/<id>/<route>`.
 */
export interface GatewayServiceCapability {
  mode: "service";
  /** The capability's name in errors and logs. */
  label: string;
  /** The access levels it offers; the manifest may ask for these only. */
  access: readonly CapabilityAccess[];
  /** Routes under `/api/integrations/<id>/`, each with the methods it takes. */
  routes: Readonly<Record<string, readonly string[]>>;
  /** The gateway settings that make it ready (status, the dev fallback). */
  settings: readonly string[];
  /** Settings it reads when set (another transport), ready or not. */
  optionalSettings: readonly string[];
}

/** Where the gateway puts an OAuth client on a token request. */
export type OAuthClientInjection = "form" | "basic" | "query" | "json";

/** A token endpoint an `oauth_client` capability completes, with its rule. */
export interface OAuthTokenEndpoint {
  /**
   * The endpoint's host, always over https. Absent: the host the
   * capability's `hostSetting` names (an instance the operator chose).
   */
  host?: string;
  /** The exact pathname, or a RegExp for versioned ones (Meta's `/v25.0/oauth/access_token`). */
  path: string | RegExp;
  methods: readonly ("GET" | "POST")[];
  /**
   * Where the client goes: the form body, HTTP Basic, the query string, or
   * the JSON body (injectClientCredentials() in ./oauthClient.ts).
   */
  inject: OAuthClientInjection;
  /** The fields' names when not `client_id` / `client_secret` (TikTok's `client_key`). */
  params?: { clientId?: string; clientSecret?: string };
}

/**
 * A provider's OAuth client the gateway holds. The gateway completes its
 * token endpoints only (`token`), putting the client on each request; the
 * app builds the authorize URL from the public client id and calls the
 * provider's API with the user tokens it keeps.
 */
export interface OAuthClientCapability {
  mode: "oauth_client";
  /** The provider's name in errors and logs. */
  label: string;
  /** Gateway secret names. No `clientSecret`: a public client, the id alone. */
  secrets: { clientId: string; clientSecret?: string };
  /** The only calls the gateway completes; anything else is refused. */
  token: readonly OAuthTokenEndpoint[];
  /**
   * A gateway setting naming the provider's origin, for a provider with no
   * fixed one (Mastodon's instance): the host of `token` entries without
   * their own, and of the authorize URL.
   */
  hostSetting?: string;
  /** The origin when `hostSetting` is unset. */
  defaultOrigin?: string;
  /** Obtaining and refreshing user tokens with the operator's client writes. */
  access: readonly ["write"];
  /** Where the operator registers the client. */
  console: string;
  /**
   * The authorize endpoint the app sends people to (a path on the
   * `hostSetting` origin when the provider has none fixed) and the scopes
   * the client must be allowed: the operator's checklist and the docs.
   */
  authorize: { url: string; scopes: readonly string[] };
  /** Hosts the app calls afterwards with the user's token (docs only). */
  api: readonly string[];
  /**
   * The redirect paths the operator registers, on the app's host
   * (`https://<app>.<APP_BASE_DOMAIN><path>`): Postiz's callback pages, the
   * first app to use these clients.
   */
  redirectPaths: readonly string[];
}

export type Capability =
  | ApiKeyCapability
  | OAuthClientCapability
  | GatewayServiceCapability;

export const CAPABILITIES = {
  dataforseo: {
    mode: "api_key",
    label: "DataForSEO",
    secret: "DATAFORSEO_API_KEY",
    // The sandbox answers like production, with made-up data and no charge.
    hosts: ["api.dataforseo.com", "sandbox.dataforseo.com"],
    access: ["read"],
    // Every DataForSEO endpoint reads data, the paid live POSTs included;
    // none changes anything the organization owns.
    readMethods: ["GET", "POST"],
    // Results are fetched by task id, which only the app that posted the
    // task holds; these list every task, error and setting on the account.
    accountWidePaths: [
      ["tasks_ready"],
      ["id_list"],
      ["errors"],
      ["appendix", "user_data"],
      ["appendix", "webhook_resend"],
    ],
    authorization: (key) => `Basic ${dataForSeoCredentials(key)}`,
  },
  context: {
    mode: "api_key",
    label: "Context.dev",
    secret: "CONTEXT_API_KEY",
    hosts: ["api.context.dev"],
    access: ["read"],
    // Scraping and rendering pages reads the web; nothing it owns changes.
    readMethods: ["GET", "POST"],
    accountWidePaths: [],
    authorization: (key) => `Bearer ${key.trim()}`,
  },
  // Outbound mail through the gateway's own sender and transport
  // (apps/every-app-gateway/src/server/capabilities/email.ts): one sending
  // domain onboarded per gateway, its daily budgets, attribution and logs.
  email: {
    mode: "service",
    label: "Email",
    access: ["write"],
    routes: { send: ["POST"] },
    settings: ["EMAIL_FROM", "EMAIL_FROM_NAME"],
    // Set both and mail goes through Email Sending's REST API instead of
    // the gateway's EMAIL binding (a gateway outside Workers, local dev).
    optionalSettings: ["EMAIL_REST_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  },
  // Social networks' OAuth clients (docs/capabilities.md "OAuth clients"):
  // the gateway completes their token endpoints only. Postiz connects its
  // channels with them; one client serves every organization on the gateway.
  linkedin: {
    mode: "oauth_client",
    label: "LinkedIn",
    secrets: {
      clientId: "LINKEDIN_CLIENT_ID",
      clientSecret: "LINKEDIN_CLIENT_SECRET",
    },
    token: [
      {
        host: "www.linkedin.com",
        path: "/oauth/v2/accessToken",
        methods: ["POST"],
        inject: "form",
      },
    ],
    access: ["write"],
    console: "https://www.linkedin.com/developers/apps",
    authorize: {
      url: "https://www.linkedin.com/oauth/v2/authorization",
      scopes: [
        "openid",
        "profile",
        "w_member_social",
        "r_basicprofile",
        "rw_organization_admin",
        "w_organization_social",
        "r_organization_social",
      ],
    },
    api: ["api.linkedin.com"],
    // Profiles and pages: both callbacks complete on the one client.
    redirectPaths: [
      "/integrations/social/linkedin",
      "/integrations/social/linkedin-page",
    ],
  },
  facebook: {
    mode: "oauth_client",
    label: "Facebook",
    secrets: {
      clientId: "FACEBOOK_APP_ID",
      clientSecret: "FACEBOOK_APP_SECRET",
    },
    token: [
      {
        // The code exchange and the long-lived token exchange, both on a
        // versioned path (/v25.0/oauth/access_token).
        host: "graph.facebook.com",
        path: /^\/v\d+\.\d+\/oauth\/access_token$/,
        methods: ["GET", "POST"],
        inject: "query",
      },
    ],
    access: ["write"],
    console: "https://developers.facebook.com/apps",
    authorize: {
      url: "https://www.facebook.com/v25.0/dialog/oauth",
      // Facebook pages, and Instagram business accounts through them.
      scopes: [
        "pages_show_list",
        "business_management",
        "pages_manage_posts",
        "pages_manage_engagement",
        "pages_read_engagement",
        "read_insights",
        "instagram_basic",
        "instagram_content_publish",
        "instagram_manage_comments",
        "instagram_manage_insights",
      ],
    },
    api: ["graph.facebook.com", "graph.instagram.com"],
    redirectPaths: [
      "/integrations/social/facebook",
      "/integrations/social/instagram",
    ],
  },
  instagram: {
    mode: "oauth_client",
    label: "Instagram",
    secrets: {
      clientId: "INSTAGRAM_APP_ID",
      clientSecret: "INSTAGRAM_APP_SECRET",
    },
    token: [
      // The code exchange, then the long-lived token exchange.
      {
        host: "api.instagram.com",
        path: "/oauth/access_token",
        methods: ["POST"],
        inject: "form",
      },
      {
        host: "graph.instagram.com",
        path: "/access_token",
        methods: ["GET"],
        inject: "query",
      },
    ],
    access: ["write"],
    console: "https://developers.facebook.com/apps",
    authorize: {
      url: "https://www.instagram.com/oauth/authorize",
      scopes: [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_comments",
        "instagram_business_manage_insights",
      ],
    },
    api: ["graph.instagram.com"],
    redirectPaths: ["/integrations/social/instagram-standalone"],
  },
  threads: {
    mode: "oauth_client",
    label: "Threads",
    secrets: { clientId: "THREADS_APP_ID", clientSecret: "THREADS_APP_SECRET" },
    token: [
      // The code exchange, then the long-lived token exchange.
      {
        host: "graph.threads.net",
        path: "/oauth/access_token",
        methods: ["GET", "POST"],
        inject: "query",
      },
      {
        host: "graph.threads.net",
        path: "/access_token",
        methods: ["GET"],
        inject: "query",
      },
    ],
    access: ["write"],
    console: "https://developers.facebook.com/apps",
    authorize: {
      url: "https://threads.net/oauth/authorize",
      scopes: [
        "threads_basic",
        "threads_content_publish",
        "threads_manage_replies",
        "threads_manage_insights",
      ],
    },
    api: ["graph.threads.net"],
    redirectPaths: ["/integrations/social/threads"],
  },
  youtube: {
    mode: "oauth_client",
    label: "YouTube",
    secrets: {
      clientId: "YOUTUBE_CLIENT_ID",
      clientSecret: "YOUTUBE_CLIENT_SECRET",
    },
    token: [
      {
        host: "oauth2.googleapis.com",
        path: "/token",
        methods: ["POST"],
        inject: "form",
      },
    ],
    access: ["write"],
    console: "https://console.cloud.google.com/apis/credentials",
    authorize: {
      url: "https://accounts.google.com/o/oauth2/v2/auth",
      // YouTube channels, and Google Business Profiles on the same client.
      scopes: [
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/youtube",
        "https://www.googleapis.com/auth/youtube.force-ssl",
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtubepartner",
        "https://www.googleapis.com/auth/yt-analytics.readonly",
        "https://www.googleapis.com/auth/business.manage",
      ],
    },
    api: [
      "www.googleapis.com",
      "youtubeanalytics.googleapis.com",
      "mybusinessaccountmanagement.googleapis.com",
      "mybusinessbusinessinformation.googleapis.com",
      "mybusiness.googleapis.com",
      "businessprofileperformance.googleapis.com",
    ],
    redirectPaths: ["/integrations/social/youtube", "/integrations/social/gmb"],
  },
  tiktok: {
    mode: "oauth_client",
    label: "TikTok",
    secrets: {
      clientId: "TIKTOK_CLIENT_ID",
      clientSecret: "TIKTOK_CLIENT_SECRET",
    },
    token: [
      {
        host: "open.tiktokapis.com",
        path: "/v2/oauth/token/",
        methods: ["POST"],
        inject: "form",
        // TikTok calls the client id its client key.
        params: { clientId: "client_key" },
      },
    ],
    access: ["write"],
    console: "https://developers.tiktok.com/apps",
    authorize: {
      url: "https://www.tiktok.com/v2/auth/authorize/",
      scopes: [
        "video.list",
        "user.info.basic",
        "video.publish",
        "video.upload",
        "user.info.profile",
        "user.info.stats",
      ],
    },
    api: ["open.tiktokapis.com"],
    redirectPaths: ["/integrations/social/tiktok"],
  },
  "tiktok-business": {
    mode: "oauth_client",
    label: "TikTok Business",
    secrets: {
      clientId: "TIKTOK_BUSINESS_CLIENT_ID",
      clientSecret: "TIKTOK_BUSINESS_CLIENT_SECRET",
    },
    token: [
      {
        host: "business-api.tiktok.com",
        path: "/open_api/v1.3/tt_user/oauth2/token/",
        methods: ["POST"],
        inject: "json",
      },
      {
        host: "business-api.tiktok.com",
        path: "/open_api/v1.3/tt_user/oauth2/refresh_token/",
        methods: ["POST"],
        inject: "json",
      },
    ],
    access: ["write"],
    console: "https://business-api.tiktok.com/portal/apps",
    authorize: {
      url: "https://www.tiktok.com/v2/auth/authorize/",
      scopes: [
        "user.info.basic",
        "user.info.username",
        "user.info.stats",
        "video.list",
        "video.upload",
        "video.publish",
      ],
    },
    api: ["business-api.tiktok.com"],
    // TikTok Business wants the trailing slash.
    redirectPaths: ["/integrations/social/tiktok-business/"],
  },
  reddit: {
    mode: "oauth_client",
    label: "Reddit",
    secrets: {
      clientId: "REDDIT_CLIENT_ID",
      clientSecret: "REDDIT_CLIENT_SECRET",
    },
    token: [
      {
        host: "www.reddit.com",
        path: "/api/v1/access_token",
        methods: ["POST"],
        inject: "basic",
      },
    ],
    access: ["write"],
    console: "https://www.reddit.com/prefs/apps",
    authorize: {
      url: "https://www.reddit.com/api/v1/authorize",
      scopes: ["read", "identity", "submit", "flair"],
    },
    api: ["oauth.reddit.com"],
    redirectPaths: ["/integrations/social/reddit"],
  },
  pinterest: {
    mode: "oauth_client",
    label: "Pinterest",
    secrets: {
      clientId: "PINTEREST_CLIENT_ID",
      clientSecret: "PINTEREST_CLIENT_SECRET",
    },
    token: [
      {
        host: "api.pinterest.com",
        path: "/v5/oauth/token",
        methods: ["POST"],
        inject: "basic",
      },
    ],
    access: ["write"],
    console: "https://developers.pinterest.com/apps/",
    authorize: {
      url: "https://www.pinterest.com/oauth/",
      scopes: [
        "boards:read",
        "boards:write",
        "pins:read",
        "pins:write",
        "user_accounts:read",
      ],
    },
    api: ["api.pinterest.com"],
    redirectPaths: ["/integrations/social/pinterest"],
  },
  discord: {
    mode: "oauth_client",
    label: "Discord",
    secrets: {
      clientId: "DISCORD_CLIENT_ID",
      clientSecret: "DISCORD_CLIENT_SECRET",
    },
    token: [
      {
        host: "discord.com",
        path: "/api/oauth2/token",
        methods: ["POST"],
        inject: "basic",
      },
    ],
    access: ["write"],
    console: "https://discord.com/developers/applications",
    // The server install; posting uses the bot's token, an app secret.
    authorize: {
      url: "https://discord.com/oauth2/authorize",
      scopes: ["bot", "identify", "guilds"],
    },
    api: ["discord.com"],
    redirectPaths: ["/integrations/social/discord"],
  },
  slack: {
    mode: "oauth_client",
    label: "Slack",
    secrets: {
      clientId: "SLACK_CLIENT_ID",
      clientSecret: "SLACK_CLIENT_SECRET",
    },
    token: [
      {
        host: "slack.com",
        path: "/api/oauth.v2.access",
        methods: ["POST"],
        inject: "form",
      },
    ],
    access: ["write"],
    console: "https://api.slack.com/apps",
    authorize: {
      url: "https://slack.com/oauth/v2/authorize",
      scopes: [
        "channels:read",
        "chat:write",
        "users:read",
        "groups:read",
        "channels:join",
        "chat:write.customize",
      ],
    },
    api: ["slack.com"],
    redirectPaths: ["/integrations/social/slack"],
  },
  mastodon: {
    mode: "oauth_client",
    label: "Mastodon",
    secrets: {
      clientId: "MASTODON_CLIENT_ID",
      clientSecret: "MASTODON_CLIENT_SECRET",
    },
    // On the instance the operator registered the client on.
    token: [{ path: "/oauth/token", methods: ["POST"], inject: "form" }],
    hostSetting: "MASTODON_URL",
    defaultOrigin: "https://mastodon.social",
    access: ["write"],
    console: "/settings/applications",
    authorize: {
      url: "/oauth/authorize",
      scopes: ["write:statuses", "profile", "write:media"],
    },
    api: [],
    redirectPaths: ["/integrations/social/mastodon"],
  },
  kick: {
    mode: "oauth_client",
    label: "Kick",
    secrets: { clientId: "KICK_CLIENT_ID", clientSecret: "KICK_CLIENT_SECRET" },
    token: [
      {
        host: "id.kick.com",
        path: "/oauth/token",
        methods: ["POST"],
        inject: "form",
      },
    ],
    access: ["write"],
    console: "https://kick.com/settings/developer",
    authorize: {
      url: "https://id.kick.com/oauth/authorize",
      scopes: ["chat:write", "user:read", "channel:read"],
    },
    api: ["api.kick.com"],
    redirectPaths: ["/integrations/social/kick"],
  },
  twitch: {
    mode: "oauth_client",
    label: "Twitch",
    secrets: {
      clientId: "TWITCH_CLIENT_ID",
      clientSecret: "TWITCH_CLIENT_SECRET",
    },
    token: [
      {
        host: "id.twitch.tv",
        path: "/oauth2/token",
        methods: ["POST"],
        inject: "form",
      },
    ],
    access: ["write"],
    console: "https://dev.twitch.tv/console/apps",
    authorize: {
      url: "https://id.twitch.tv/oauth2/authorize",
      scopes: [
        "user:write:chat",
        "user:read:chat",
        "moderator:manage:announcements",
      ],
    },
    // Helix also wants the public client id, as Client-Id, on every call.
    api: ["api.twitch.tv"],
    redirectPaths: ["/integrations/social/twitch"],
  },
  tumblr: {
    mode: "oauth_client",
    label: "Tumblr",
    secrets: {
      clientId: "TUMBLR_CLIENT_ID",
      clientSecret: "TUMBLR_CLIENT_SECRET",
    },
    token: [
      {
        host: "api.tumblr.com",
        path: "/v2/oauth2/token",
        methods: ["POST"],
        inject: "form",
      },
    ],
    access: ["write"],
    console: "https://www.tumblr.com/oauth/apps",
    authorize: {
      url: "https://www.tumblr.com/oauth2/authorize",
      scopes: ["write", "offline_access"],
    },
    api: ["api.tumblr.com"],
    redirectPaths: ["/integrations/social/tumblr"],
  },
  dribbble: {
    mode: "oauth_client",
    label: "Dribbble",
    secrets: {
      clientId: "DRIBBBLE_CLIENT_ID",
      clientSecret: "DRIBBBLE_CLIENT_SECRET",
    },
    token: [
      {
        // A POST that takes the client in its query string.
        host: "dribbble.com",
        path: "/oauth/token",
        methods: ["POST"],
        inject: "query",
      },
    ],
    access: ["write"],
    console: "https://dribbble.com/account/applications",
    authorize: {
      url: "https://dribbble.com/oauth/authorize",
      scopes: ["public", "upload"],
    },
    api: ["api.dribbble.com"],
    redirectPaths: ["/integrations/social/dribbble"],
  },
} as const satisfies Record<string, Capability>;

export type CapabilityId = keyof typeof CAPABILITIES;

type CapabilityIdOf<Mode extends Capability["mode"]> = {
  [K in CapabilityId]: (typeof CAPABILITIES)[K]["mode"] extends Mode
    ? K
    : never;
}[CapabilityId];

/** Capabilities an app calls with `integrationFetch()`: providers whose key the gateway holds. */
export type ApiKeyCapabilityId = CapabilityIdOf<"api_key">;

/** Capabilities the gateway performs itself, each with its SDK helper. */
export type ServiceCapabilityId = CapabilityIdOf<"service">;

/** OAuth clients whose token endpoints apps reach with `integrationFetch()`. */
export type OAuthClientCapabilityId = CapabilityIdOf<"oauth_client">;

type SettingsOf<C> = C extends { secret: infer S extends string }
  ? S
  : C extends {
        settings: readonly (infer S extends string)[];
        optionalSettings: readonly (infer O extends string)[];
      }
    ? S | O
    : C extends { secrets: infer S }
      ?
          | (S[keyof S] & string)
          | (C extends { hostSetting: infer H extends string } ? H : never)
      : never;

/** The gateway settings capabilities read: keys, clients, senders, transports. */
export type CapabilitySecret = SettingsOf<(typeof CAPABILITIES)[CapabilityId]>;

/** Every gateway setting `capability` reads, the ones it needs first. */
export function capabilitySettings(capability: Capability): readonly string[] {
  switch (capability.mode) {
    case "api_key":
      return [capability.secret];
    case "service":
      return [...capability.settings, ...capability.optionalSettings];
    case "oauth_client":
      return [
        capability.secrets.clientId,
        ...(capability.secrets.clientSecret
          ? [capability.secrets.clientSecret]
          : []),
        ...(capability.hostSetting ? [capability.hostSetting] : []),
      ];
  }
}

export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[];

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && Object.hasOwn(CAPABILITIES, value);
}

/** Where AppGateway serves capability calls. */
export const INTEGRATION_PROXY_PREFIX = "/api/integrations";

/**
 * The AppGateway path for a call to `upstream`:
 * `/api/integrations/<id>/<host><path>?<query>`. The host is in the path so
 * a provider with several API hosts needs no other channel.
 */
export function integrationProxyPath(
  id: ApiKeyCapabilityId | OAuthClientCapabilityId,
  upstream: URL,
): string {
  return `${INTEGRATION_PROXY_PREFIX}/${id}/${upstream.host}${upstream.pathname}${upstream.search}`;
}

/** The AppGateway path of a service capability's route: `/api/integrations/<id>/<route>`. */
export function serviceRoutePath(
  id: ServiceCapabilityId,
  route: string,
): string {
  return `${INTEGRATION_PROXY_PREFIX}/${id}/${route}`;
}

/** What an AppGateway capability path names. */
export type IntegrationProxyRoute =
  /** A call the gateway forwards to the provider's `upstream` with its key. */
  | { kind: "api_key"; id: ApiKeyCapabilityId; upstream: URL }
  /** A call to one of an OAuth client's token endpoints, with its rule. */
  | {
      kind: "oauth_client";
      id: OAuthClientCapabilityId;
      upstream: URL;
      endpoint: OAuthTokenEndpoint;
    }
  /** A call to one of the routes a service capability declares. */
  | { kind: "service"; id: ServiceCapabilityId; route: string };

/** Gateway settings by name: the gateway's env, or `.dev.vars` in dev. */
export type CapabilitySettings = Readonly<Record<string, unknown>>;

/**
 * The capability call an AppGateway path names, or null when the path names
 * an unknown capability, a host outside the provider's, a path that could
 * leave that host, a path that isn't one of an OAuth client's token
 * endpoints, or a route a service capability doesn't declare. `settings`
 * resolves an OAuth client's `hostSetting` (Mastodon's instance).
 */
export function parseIntegrationProxyPath(
  pathname: string,
  search: string,
  settings?: CapabilitySettings,
): IntegrationProxyRoute | null {
  const match = /^\/api\/integrations\/([a-z][a-z0-9-]*)\/([^/]+)(\/.*)?$/.exec(
    pathname,
  );
  if (!match) return null;
  const [, id, host = "", path] = match;
  if (!isCapabilityId(id)) return null;
  const capability: Capability = CAPABILITIES[id];
  if (capability.mode === "service") {
    // A route is one segment; nothing may follow it.
    if (path !== undefined || !Object.hasOwn(capability.routes, host)) {
      return null;
    }
    return { kind: "service", id: id as ServiceCapabilityId, route: host };
  }
  if (capability.mode === "oauth_client") {
    const upstream = oauthClientHosts(capability, settings).includes(host)
      ? httpsUpstream(host, path ?? "/", search)
      : null;
    const endpoint =
      upstream && tokenEndpointFor(capability, upstream, settings);
    if (!upstream || !endpoint) return null;
    return {
      kind: "oauth_client",
      id: id as OAuthClientCapabilityId,
      upstream,
      endpoint,
    };
  }
  const upstream = (capability.hosts as readonly string[]).includes(host)
    ? httpsUpstream(host, path ?? "/", search)
    : null;
  if (!upstream) return null;
  return { kind: "api_key", id: id as ApiKeyCapabilityId, upstream };
}

/** `https://<host><path><search>`, or null for a path that could leave `host`. */
function httpsUpstream(host: string, path: string, search: string): URL | null {
  if (path.startsWith("//") || path.includes("\\")) return null;
  const upstream = new URL(`https://${host}${path}${search}`);
  // A parser quirk must never move the key to another host.
  if (upstream.host !== host || upstream.protocol !== "https:") return null;
  return upstream;
}

/**
 * The origin an OAuth client's `hostSetting` names (its default when the
 * setting is unset), or null for a client with a fixed host or a setting
 * that isn't an https origin. A bare host is taken as https.
 */
export function oauthClientOrigin(
  capability: OAuthClientCapability,
  settings: CapabilitySettings | undefined,
): string | null {
  if (!capability.hostSetting) return null;
  const set = settings?.[capability.hostSetting];
  const value =
    typeof set === "string" && set.trim()
      ? set.trim()
      : capability.defaultOrigin;
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`,
    );
  } catch {
    return null;
  }
  // An origin and nothing else: the paths are the provider's own.
  const bare =
    url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  return url.protocol === "https:" && bare ? url.origin : null;
}

/** The host an OAuth client's `hostSetting` names, or null. */
function settingHost(
  capability: OAuthClientCapability,
  settings: CapabilitySettings | undefined,
): string | null {
  const origin = oauthClientOrigin(capability, settings);
  return origin ? new URL(origin).host : null;
}

/** The hosts an OAuth client's token endpoints are on. */
function oauthClientHosts(
  capability: OAuthClientCapability,
  settings: CapabilitySettings | undefined,
): string[] {
  const fromSetting = settingHost(capability, settings);
  return [
    ...new Set(
      capability.token.flatMap(({ host }) => {
        const resolved = host ?? fromSetting;
        return resolved ? [resolved] : [];
      }),
    ),
  ];
}

/**
 * The token endpoint `upstream` is, by its exact host and path (a RegExp
 * for a versioned one), or null. Its method is the caller's to check.
 */
export function tokenEndpointFor(
  capability: OAuthClientCapability,
  upstream: URL,
  settings: CapabilitySettings | undefined,
): OAuthTokenEndpoint | null {
  if (upstream.protocol !== "https:") return null;
  const fromSetting = settingHost(capability, settings);
  return (
    capability.token.find(
      ({ host, path }) =>
        (host ?? fromSetting) === upstream.host &&
        (typeof path === "string"
          ? path === upstream.pathname
          : path.test(upstream.pathname)),
    ) ?? null
  );
}

/** An OAuth client's token endpoints, as `POST https://host/path` lines for messages. */
export function describeTokenEndpoints(
  capability: OAuthClientCapability,
): string {
  return capability.token
    .map(
      ({ host, path, methods }) =>
        `${methods.join("/")} https://${host ?? `<${capability.hostSetting}>`}${tokenPathText(path)}`,
    )
    .join(", ");
}

/** A token endpoint's path as people read it: a versioned one as `/v<version>/oauth/access_token`. */
export function tokenPathText(path: string | RegExp): string {
  if (typeof path === "string") return path;
  return path.source
    .replace(/^\^|\$$/g, "")
    .replace(/v\\d\+\\\.\\d\+/g, "v<version>")
    .replace(/\\(.)/g, "$1");
}

/**
 * The command that gives the gateway `capability`'s client:
 * `pnpm everyapp secret set <ID> <SECRET> [<HOST SETTING>] --for gateway`.
 */
export function oauthClientSecretSetCommand(
  capability: OAuthClientCapability,
): string {
  return `pnpm everyapp secret set ${capabilitySettings(capability).join(" ")} --for gateway`;
}

/** Times a path may decode to something new before it counts as hiding one. */
const MAX_PATH_DECODES = 3;
/** Control, zero-width and whitespace characters: in no endpoint's path. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Z}\s]/u;
/**
 * The part of a segment a provider can route on: an endpoint's name ends at
 * the first character no name has, so `tasks_ready,`, `tasks_ready;x` and
 * `tasks_ready.json` all name `tasks_ready`.
 */
const SEGMENT_NAME = /^[a-z0-9_-]*/;

/**
 * Whether `pathname` reaches one of the capability's account-wide paths,
 * however it is spelled: percent-encoded (twice, even), in another case,
 * with a suffix on a segment, with doubled or backslash separators, or with
 * a trailing segment. A path that doesn't decode, or that holds control
 * characters or whitespace once decoded, counts as one; so does anything
 * outside ASCII for a provider that has account-wide paths, since how it
 * folds case is its own business.
 */
export function isAccountWidePath(
  capability: ApiKeyCapability,
  pathname: string,
): boolean {
  const decoded = decodePath(pathname);
  if (decoded === null || UNPRINTABLE.test(decoded)) return true;
  const blocked = capability.accountWidePaths;
  if (blocked.length === 0) return false;
  if (!/^[\x20-\x7e]*$/.test(decoded)) return true;
  // Empty segments drop out, as on a server that merges slashes.
  const segments = decoded.split(/[/\\]/).filter(Boolean);
  // The URL parser already resolved every dot segment it could see; one
  // that only decoding reveals is a disguise.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return true;
  }
  const names = segments.map(
    (segment) => SEGMENT_NAME.exec(segment)?.[0] ?? "",
  );
  return blocked.some((path) =>
    names.some((_, start) =>
      path.every((name, offset) => names[start + offset] === name),
    ),
  );
}

/** `pathname` percent-decoded until it stops changing, lowercased; null if it won't. */
function decodePath(pathname: string): string | null {
  let current = pathname;
  for (let round = 0; round <= MAX_PATH_DECODES; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current.toLowerCase();
    current = next;
  }
  return null;
}

/**
 * DataForSEO uses Basic auth with the API login and password. The key may be
 * `login:password` as the dashboard shows them, or already base64-encoded
 * (what OpenSEO's DATAFORSEO_API_KEY has always held).
 */
function dataForSeoCredentials(key: string): string {
  const trimmed = key.trim();
  return trimmed.includes(":") ? base64Utf8(trimmed) : trimmed;
}

/** The base64 of `text`'s UTF-8 bytes (`btoa` takes Latin-1 only). */
export function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
