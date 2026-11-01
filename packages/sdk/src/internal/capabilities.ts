/**
 * The built-in provider catalog: everything the gateway holds a credential
 * for on apps' behalf (docs/capabilities.md,
 * docs/design/2026-10-provider-registry.md), of four kinds, each an entry
 * of data and nothing else, so a provider the catalog doesn't have can be
 * registered on one gateway as a row of the same shape (./providerSpec.ts,
 * ./providerRegistry.ts):
 *
 *  - `api_key`: a provider whose key the gateway holds. The operator sets
 *    the key once on the gateway (`everyapp secret set <secret>`), an app lists the provider in its manifest's `capabilities`,
 *    and the app calls the provider through the AppGateway binding
 *    (`integrationFetch()`), so no app ever holds the key. `auth` says
 *    where the key goes on the request ({@link ApiKeyAuth}).
 *  - `ai`: an AI provider, reached under `providers` in the manifest and
 *    `/api/ai/<id>` on the binding (`createGatewayFetch()`), with the AI
 *    proxy's rules: inference routes only, the model allowlist, the usage
 *    tap. Never a capability: its key would reach the account's credits
 *    and keys on the same host.
 *  - `oauth_client`: a provider's OAuth client (Google's, Microsoft's,
 *    Slack's), held the same way. The gateway completes the token endpoint
 *    calls only, putting the client on them; the app builds the authorize
 *    URL from the public client id (`integrationStatus()`), sends people
 *    back to a callback its manifest entry lists (`redirectPaths`), keeps
 *    the user tokens and calls the provider's API with them itself. Other
 *    providers' clients (GitHub, the social networks) are presets
 *    (./oauthPresets.ts): rows only once an operator adds one. A client shared by apps
 *    with different needs carries a `scopePolicy`: named scope sets an app
 *    lists in its manifest entry's `scopes`, which ./oauthScopes.ts turns
 *    into what the app may ask the provider for and what a token it is
 *    handed may carry.
 *  - `service`: something the gateway does itself, with no upstream host
 *    an app names (sending email, listing the organization's members). An
 *    app lists it the same way and calls its routes,
 *    `/api/integrations/<id>/<route>`, through the SDK's own helper
 *    (`sendEmail()`, `listMembers()`).
 *
 * The gateway enforces these definitions, the manifest validator checks
 * `capabilities` against them, and the SDK reads them for its local-dev
 * fallback, which calls the provider directly with a developer's own key.
 * All three import them from here so they cannot drift.
 */

/** What an app may ask to do with a capability. */
export type CapabilityAccess = "read" | "write";

/**
 * Where an API-key provider's key goes on a request, as data: the same
 * four kinds a remote MCP app's credential takes. `secret` is always the
 * name of a Gateway setting (in local dev, the `.dev.vars` name), never a
 * value. {@link authorizationFor} turns one into headers or a query
 * parameter from the settings.
 */
export type ApiKeyAuth =
  /** `Authorization: Bearer <key>`; `scheme` for a provider that spells it `Token` or `Api-Key`. */
  | { kind: "bearer"; secret: string; scheme?: string }
  /** `<header>: <prefix><key>` (`x-api-key: <key>`, `Authorization: Klaviyo-API-Key <key>`). */
  | { kind: "header"; secret: string; header: string; prefix?: string }
  /** `?<param>=<key>` on the query string. */
  | { kind: "query"; secret: string; param: string }
  /**
   * `Authorization: Basic base64(user:password)`, the placement said
   * outright, never guessed from the value: the secret is the password
   * beside `user` (a literal, Mailgun's `api`; or `{ secret }`, a second
   * Gateway setting, Twilio's SID), the username with an empty password
   * (Segment, Mixpanel, Crisp), or the whole `login:password` pair, which
   * may already be base64-encoded (DataForSEO's rule: a base64 string
   * never holds a colon).
   */
  | {
      kind: "basic";
      secret: string;
      as: "password";
      user: string | { secret: string };
    }
  | { kind: "basic"; secret: string; as: "username" }
  | { kind: "basic"; secret: string; as: "pair" };

/** What a provider says about one of its Gateway settings, for whoever sets it. */
export interface ProviderSecretDetail {
  name: string;
  /** What kind of key, in one sentence: "A restricted key with read access to Customers is enough." */
  hint?: string;
}

/** What a call costs, for the usage counters and the setup text. */
export interface ProviderCost {
  unit: "call" | "result" | "token";
  usd?: number;
  note?: string;
  /**
   * The field of the provider's JSON answer that reports the call's cost
   * in US dollars, added to the usage counters: a top-level name the
   * capability proxy reads off the head of every answer (DataForSEO's
   * `cost`), or a dotted path the AI proxy reads off the tail with the
   * token usage (OpenRouter's `usage.cost`). Absent: nothing is read, and
   * `usd` is the flat per-call price where the provider has one.
   */
  responseField?: string;
}

/** The provider's rate limits, as hints beside the counters. */
export interface ProviderRate {
  perSecond?: number;
  perMinute?: number;
  perDay?: number;
  note?: string;
}

/** One request that costs nothing, for a setup guide's Verify step. */
export interface SmokeRequest {
  method: "GET" | "HEAD" | "POST";
  /** One of the provider's hosts; the first when absent. */
  host?: string;
  path: string;
  /** The statuses that mean the key works. */
  expect: readonly number[];
  free: boolean;
  note?: string;
}

/** Whether somebody checked the entry against the provider's docs, and how. */
export type ProviderVerification = { on: string; how: "docs" | "live" } | false;

/** What every provider may say about itself beyond what the gateway enforces. */
export interface ProviderDetails {
  /** What it is for, in one line, for lists and agents. */
  description?: string;
  /** The API reference, when it isn't the `docs` page. */
  api?: string;
  /**
   * The setup sentence the "Needs setup" dialog and `everyapp status` show
   * when there is no guide, or beside one: what the key is and where it
   * comes from, 1 to 3 sentences.
   */
  hint?: string;
  /** Detail per Gateway setting `auth` names. */
  secrets?: readonly ProviderSecretDetail[];
  /** What to say to an agent to try it, after "Use <name> to". */
  example?: string;
  cost?: ProviderCost;
  rate?: ProviderRate;
  /** One request that costs nothing and proves the key works, for a person's terminal. */
  smoke?: SmokeRequest;
  verified?: ProviderVerification;
  tags?: readonly string[];
}

export interface ApiKeyCapability extends ProviderDetails {
  mode: "api_key";
  /** The provider's name in errors and logs. */
  label: string;
  /** Where the key goes, and which Gateway setting holds it. */
  auth: ApiKeyAuth;
  /** Where an operator gets the key: the provider's API access page. */
  docs: string;
  /** The everyapp skill's setup guide for it, relative to the skill (`setup/dataforseo.md`); a row has none. */
  setup?: string;
  /** The only hosts the key is ever sent to, always over https; may be empty when `hostSetting` names the host. */
  hosts: readonly string[];
  /**
   * A Gateway setting naming the provider's host, for a provider whose host
   * is the operator's (Shopify's `<shop>.myshopify.com`): a bare host or an
   * https origin with no path, held to the host rules when read
   * ({@link apiKeyHosts}). Named after the provider like its key.
   */
  hostSetting?: string;
  /**
   * Whose data the key reaches: `per-call` (search, scrape, inference:
   * each call is its own) or `account` (every list is the whole account).
   * A hosted gateway, where one key would be every tenant's, serves
   * `account` providers to nobody until it holds per-organization keys.
   */
  data?: "per-call" | "account";
  /** The access levels the provider offers; the manifest may ask for these only. */
  access: readonly CapabilityAccess[];
  /** Methods an app asking for `access: "read"` may use. */
  readMethods: readonly string[];
  /** Methods an app asking for `access: "write"` may use besides, when the provider offers write; {@link DEFAULT_WRITE_METHODS} when absent. */
  writeMethods?: readonly string[];
  /**
   * Paths no app may reach, each as its run of path segments, refused
   * wherever those segments appear together in the upstream path however
   * it is spelled (see {@link isAccountWidePath}). One key serves every app
   * in every organization, so endpoints that list or describe the whole
   * provider account would show one app another's work.
   */
  accountWidePaths: readonly (readonly string[])[];
}

/**
 * An AI provider (OpenAI, OpenRouter, Workers AI): the AI proxy's table as
 * a catalog entry. The app's path is joined onto `origin` and `basePath`
 * (with `{SETTING}` placeholders filled from the Gateway's settings, each
 * URL-encoded) and must be one of `inferenceRoutes` (a POST), unless both
 * the operator (`AI_PROXY_EXTRA_ROUTES`) and the app's manifest (`ai.routes`)
 * allow more (`extraRoutes`). `unstoredRoutes` get `store: false`.
 * `normalize` names the one response rewrite the gateway has.
 */
export interface AiProviderCapability extends ProviderDetails {
  mode: "ai";
  label: string;
  /** Where the key goes: bearer for the three today; Anthropic's `x-api-key` header is a `header` kind. */
  auth: ApiKeyAuth;
  /**
   * The auth setting is read when set and the entry works without it:
   * Cloudflare AI Gateway's own token (`cf-aig-authorization`), which an
   * authenticated gateway requires and an open one ignores. Never a need.
   */
  authOptional?: true;
  docs: string;
  setup?: string;
  /** `https://api.openai.com`. */
  origin: string;
  /** Gateway settings the URL needs besides the key (`CLOUDFLARE_ACCOUNT_ID`). */
  alsoNeeds?: readonly string[];
  /** Joined onto the origin before every path: `/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai`. */
  basePath?: string;
  inferenceRoutes: readonly string[];
  unstoredRoutes?: readonly string[];
  extraRoutes?: boolean;
  normalize?: "workers-ai";
  /**
   * The request shape the provider's inference routes take: OpenAI's
   * (chat completions and the OpenAI-compatible family: OpenRouter,
   * Workers AI, Groq, Mistral, Gemini's `/v1beta/openai`), or Anthropic's
   * Messages API, or the provider's own (Cohere's v2). The Gateway's
   * default route (`/api/ai/default/…`) serves OpenAI-shaped chat, so only
   * an `openai`-shaped entry can be the default; the others are pinned by
   * an app that speaks them. Absent: `openai`.
   */
  shape?: "openai" | "anthropic" | "other";
  /**
   * Chat through the default route: the entry's chat route (one of
   * `inferenceRoutes`) that `/api/ai/default/v1/chat/completions` maps
   * onto, and the model the Gateway fills in when the app names none or
   * names `default`. Absent: the entry can't be the Gateway's default.
   */
  chat?: AiRoute;
  /** Embeddings through the default route (`/api/ai/default/v1/embeddings`), the same way. */
  embeddings?: AiRoute;
  /**
   * How Cloudflare AI Gateway fronts the provider: its slug under
   * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/`, and the
   * prefix of the provider's direct path the gateway's URL leaves out
   * (OpenRouter's `/api`, OpenAI's `/v1`); or, for Workers AI, whose REST
   * API is AI Gateway's own host, `header: true`: the call keeps its URL
   * and carries `cf-aig-gateway-id`. With `AI_GATEWAY_ID` set, every call
   * to an entry with an `aig` block goes through AI Gateway with the
   * provider's own key still on it; an entry without one goes direct
   * (Gemini's and Cohere's OpenAI-shaped paths have no documented AI
   * Gateway form, 2026-10-25).
   */
  aig?: { slug: string; trim?: string; header?: true };
  /**
   * `proxy`: the entry fronts the other AI providers (Cloudflare AI
   * Gateway) and serves no models of its own: never listed under
   * `providers`, never the default, reached through the entries it fronts.
   */
  kind?: "proxy";
  /**
   * The models the provider serves, when the entry says (a registered
   * `ai` row's `models`): the proxy refuses an inference call naming
   * another (`model_not_allowed`), and `provider show` lists them. Absent
   * on the catalog's entries, whose model lists change weekly.
   */
  models?: readonly string[];
}

/** A route of an AI provider the default route maps onto, with the model used when the app names none. */
export interface AiRoute {
  /** One of the entry's `inferenceRoutes`: `/api/v1/chat/completions`. */
  path: string;
  /**
   * The seed: the model the Gateway fills in when its operator set none
   * for this provider (`everyapp ai model`, `org_settings.ai_models`), a
   * cheap, capable one of the provider's. Data, never the only answer:
   * read it through `resolveAiDefault` (./aiDefault.ts), which puts the
   * operator's setting first.
   */
  seedModel: string;
}

/** What `access: "write"` adds to a provider's read methods when its entry doesn't say. */
export const DEFAULT_WRITE_METHODS: readonly string[] = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

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
  /** The everyapp skill's setup guide, when there is anything to set up. */
  setup?: string;
}

/** Where the gateway puts an OAuth client on a token request. */
export type OAuthClientInjection = "form" | "basic";

/** A token endpoint an `oauth_client` capability completes, with its rule. */
export interface OAuthTokenEndpoint {
  /** The endpoint's host, always over https. */
  host: string;
  /** The exact pathname. */
  path: string;
  methods: readonly ("GET" | "POST")[];
  /**
   * Where the client goes: the form body or HTTP Basic
   * (injectClientCredentials() in ./oauthClient.ts).
   */
  inject: OAuthClientInjection;
}

/**
 * One host's allowlist a scope set unlocks. Matched against the raw
 * pathname, case preserved, by `scopeRouteAllows()` in ./oauthScopes.ts:
 * the proxy boundary once the gateway holds tokens, tested data until then.
 */
export interface OAuthScopeRoute {
  /** A bare https host, one of the capability's `api` hosts. */
  host: string;
  /**
   * Raw-path entries: exact, or a prefix when the entry ends in `/`. GET
   * and HEAD go through when one matches.
   */
  paths: readonly string[];
  /**
   * The read-shaped POSTs a read set allows (queries, watches): anchored,
   * flagless RegExps over the raw pathname. Every other POST is refused.
   */
  posts?: readonly RegExp[];
}

/**
 * A named bundle an app lists under `scopes`: what it asks the provider for
 * and what that unlocks.
 */
export interface OAuthScopeSet {
  /** What Admin → Apps and a consent page call it: "Gmail (read-only)". */
  label: string;
  /**
   * A read set unlocks GET, HEAD and its `posts` only. No write set exists
   * on the shared clients yet; adding one is a reviewed registry change.
   */
  access: CapabilityAccess;
  /** The provider's scope strings, requested verbatim (Slack: bot scopes). */
  scopes: readonly string[];
  /** Slack's `user_scope` strings, issued to the installing person's own token; absent elsewhere. */
  userScopes?: readonly string[];
  routes: readonly OAuthScopeRoute[];
}

/**
 * How a provider spells granted scopes in its token response; each has a
 * parser in ./oauthScopes.ts. `space` and `comma` are the plain spellings
 * a registered provider names (`scopeDialect`): a token response without
 * a `scope` field is taken as granted-as-requested (RFC 6749 §5.1).
 */
export type OAuthScopeDialect =
  | "google"
  | "microsoft"
  | "slack"
  | "space"
  | "comma";

/**
 * Everything the gateway needs to hold an app to its scope sets at the
 * token endpoint. Present means an app's entry must list `scopes` and the
 * gateway refuses tokens outside them. Data only: the dialect selects the
 * parser, so the registry stays a table.
 */
export interface OAuthScopePolicy {
  sets: Readonly<Record<string, OAuthScopeSet>>;
  /**
   * Scopes a token may carry beyond the declared sets without refusal:
   * identity and refresh scopes, in every spelling the provider uses.
   * Never a data scope.
   */
  tolerated: readonly string[];
  /**
   * Scopes every declaring app asks for whatever its sets, on the authorize
   * URL and Microsoft's token leg (`offline_access`). Always tolerated.
   */
  alwaysRequested: readonly string[];
  dialect: OAuthScopeDialect;
  /**
   * The `tokenGrantType()` values the gateway completes through this
   * client. `null` is a code exchange that carries no `grant_type` (Slack's
   * oauth.v2.access).
   */
  grantTypes: readonly (string | null)[];
  /**
   * What becomes of the token request's `scope` once it passes the check:
   * `replace` it with the app's requested list (Microsoft's token-leg
   * extension, which keeps a token to one resource), `drop` it (Google
   * documents no `scope` on either token leg), or `keep` it (Slack).
   */
  requestScope: "replace" | "drop" | "keep";
  /**
   * Decoded path segments no set unlocks on any host, compared
   * case-insensitively: batch tunnels that carry other requests inside, and
   * resources that reveal secrets under a read scope.
   */
  deniedSegments: readonly string[];
}

/** How a provider names the account a new connection is for, read once after the exchange. */
export interface OAuthIdentity {
  /** An https URL on one of the provider's `api` hosts, GET with the new token. */
  url: string;
  /** A dot path into the JSON answer for the label ("ben", "ben@example.com"). */
  label: string;
  /** A dot path for the provider's stable id of the account (optional). */
  id?: string;
}

/**
 * What the Gateway needs to run a provider's authorization-code flow
 * itself (docs/design/2026-10-oauth-providers.md section 5): present on a
 * catalog entry that supports the Gateway-owned flow, and built from a
 * registered row's `auth` (`kind: "oauth2-user"`). Absent: the entry
 * keeps the app-driven flow only (the social networks).
 */
export interface OAuthFlow {
  /** The token endpoint the Gateway posts the code and refresh token to (https). */
  tokenUrl: string;
  /** Where a disconnect revokes the token; absent means the tokens die at their expiry. */
  revokeUrl?: string;
  /** The revoke call's method (default POST). */
  revokeMethod?: "POST" | "DELETE";
  /** Whether the authorize request carries a PKCE S256 challenge (default true). */
  pkce: boolean;
  /** How the token response spells what it granted. */
  scopeDialect: OAuthScopeDialect;
  /** Extra query on the authorize URL (Google's `access_type=offline`). */
  authorizeParams?: Readonly<Record<string, string>>;
  /** Extra headers on the token request (GitHub's `Accept: application/json`). */
  tokenHeaders?: Readonly<Record<string, string>>;
  identity?: OAuthIdentity;
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
   * Obtaining and refreshing user tokens with the operator's client
   * writes, so a catalog client is `["write"]`. A registered OAuth
   * provider says what the proxy may do with the held token: read, write
   * or both (docs/design/2026-10-oauth-providers.md section 7).
   */
  access: readonly CapabilityAccess[];
  /** Where the operator registers the client. */
  console: string;
  /** The everyapp skill's setup guide for the client, when one exists. */
  setup?: string;
  /**
   * The authorize endpoint the app sends people to and the scopes the
   * client must be allowed: the operator's checklist and the docs. With
   * a `scopePolicy`, the union of its sets' scopes and `alwaysRequested`.
   */
  authorize: { url: string; scopes: readonly string[] };
  /**
   * Named scope sets an app lists in its manifest entry's `scopes`, for a
   * client several apps share with different needs. Absent: the whole
   * client is the grant.
   */
  scopePolicy?: OAuthScopePolicy;
  /**
   * Hosts the app calls afterwards with the user's token; the Gateway's
   * held-token branch forwards to these alone, and a scope policy's
   * routes are on them.
   */
  api: readonly string[];
  /** The Gateway-owned flow, when the entry supports it. */
  flow?: OAuthFlow;
  /** A registered OAuth provider's spec fields (a catalog client has `setup` instead). */
  description?: string;
  /** The API reference (a spec's `api`), optional. */
  reference?: string;
  hint?: string;
  example?: string;
  tags?: readonly string[];
  /**
   * A registered OAuth provider's methods: what a read grant may use
   * (default GET and HEAD) and what a write grant adds (default the
   * API-key default). A catalog client leaves both unset.
   */
  readMethods?: readonly string[];
  writeMethods?: readonly string[];
}

export type Capability =
  | ApiKeyCapability
  | AiProviderCapability
  | OAuthClientCapability
  | GatewayServiceCapability;

import { CATALOG_ENTRIES } from "./catalog/index.js";

export const CAPABILITIES = {
  // The AI providers, in the order the AI proxy's table had them.
  openai: {
    mode: "ai",
    label: "OpenAI",
    description: "OpenAI's models: responses, chat, embeddings, audio, images.",
    auth: { kind: "bearer", secret: "OPENAI_API_KEY" },
    docs: "https://platform.openai.com/api-keys",
    api: "https://platform.openai.com/docs/api-reference",
    setup: "setup/openai.md",
    origin: "https://api.openai.com",
    inferenceRoutes: [
      "/v1/responses",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/audio/speech",
      "/v1/audio/transcriptions",
      "/v1/audio/translations",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/images/variations",
    ],
    unstoredRoutes: ["/v1/responses", "/v1/chat/completions"],
    // More than inference needs both the operator (AI_PROXY_EXTRA_ROUTES)
    // and the app's manifest (`ai.routes`): OpenAI paths only.
    extraRoutes: true,
    // Tool calling on chat completions needs `reasoning_effort: "none"`
    // on the GPT-6 family (the responses route takes tools as it is).
    chat: { path: "/v1/chat/completions", seedModel: "gpt-6-luna" },
    embeddings: { path: "/v1/embeddings", seedModel: "text-embedding-3-small" },
    // AI Gateway's OpenAI endpoint takes the path without `/v1`.
    aig: { slug: "openai", trim: "/v1" },
    hint: "A secret key from the API keys page; the Gateway puts it on every call as a bearer token.",
    verified: { on: "2026-10-25", how: "live" },
  },
  // OpenAI-compatible, in front of many model providers. Usage (with cost)
  // comes back in the response, so apps can meter their own spend.
  openrouter: {
    mode: "ai",
    label: "OpenRouter",
    description: "One key for many models, through OpenAI's API shape.",
    auth: { kind: "bearer", secret: "OPENROUTER_API_KEY" },
    docs: "https://openrouter.ai/settings/keys",
    api: "https://openrouter.ai/docs",
    setup: "setup/openrouter.md",
    origin: "https://openrouter.ai",
    inferenceRoutes: [
      "/api/v1/chat/completions",
      "/api/v1/completions",
      "/api/v1/responses",
      "/api/v1/embeddings",
    ],
    chat: {
      path: "/api/v1/chat/completions",
      seedModel: "anthropic/claude-haiku-5.5",
    },
    embeddings: {
      path: "/api/v1/embeddings",
      seedModel: "openai/text-embedding-3-small",
    },
    // AI Gateway's OpenRouter endpoint takes the path without `/api`.
    aig: { slug: "openrouter", trim: "/api" },
    hint: "An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.",
    // Every answer's `usage.cost` is the call's price in USD, what
    // OpenRouter charges the key: read off the tail with the tokens.
    cost: {
      unit: "token",
      responseField: "usage.cost",
      note: "The answer's usage.cost is the call's price in USD, per model.",
    },
    verified: { on: "2026-10-25", how: "live" },
  },
  // Workers AI's OpenAI-compatible REST API, in the gateway's own account
  // (`/v1/run/...` and the native `/run/<model>` stay closed). Its chat
  // streams send all-digit tokens as JSON numbers, which the gateway turns
  // back into strings (normalizeWorkersAiResponse).
  "workers-ai": {
    mode: "ai",
    label: "Workers AI",
    description: "Cloudflare's models, in the Gateway's own account.",
    auth: { kind: "bearer", secret: "WORKERS_AI_API_TOKEN" },
    // A token from the "Workers AI" template (Read and Edit).
    docs: "https://dash.cloudflare.com/profile/api-tokens",
    api: "https://developers.cloudflare.com/workers-ai/",
    setup: "setup/workers-ai.md",
    origin: "https://api.cloudflare.com",
    alsoNeeds: ["CLOUDFLARE_ACCOUNT_ID"],
    basePath: "/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai",
    inferenceRoutes: [
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/responses",
    ],
    normalize: "workers-ai",
    chat: {
      path: "/v1/chat/completions",
      seedModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
    },
    embeddings: { path: "/v1/embeddings", seedModel: "@cf/baai/bge-m3" },
    // Workers AI's REST API is AI Gateway's own host: the URL stays and
    // `cf-aig-gateway-id` names the gateway.
    aig: { slug: "workers-ai", header: true },
    hint: "A Cloudflare API token with Workers AI Read (the Workers AI page's prefilled token); the account is the Gateway's own.",
    verified: { on: "2026-10-25", how: "live" },
  },
  // Cloudflare AI Gateway: a proxy in front of the other AI providers
  // (logs, caching, rate limits, spend), with no models of its own. With
  // AI_GATEWAY_ID set, every call to an `ai` entry that has an `aig` slug
  // goes through it, the provider's own key still on the call; the
  // gateway's own token is optional (an authenticated gateway requires
  // it). Never listed under `providers`: it fronts the entries apps list.
  "ai-gateway": {
    mode: "ai",
    kind: "proxy",
    label: "Cloudflare AI Gateway",
    description:
      "Cloudflare's proxy in front of the other AI providers: logs, caching, rate limits and spend, with each provider's own key.",
    auth: {
      kind: "header",
      header: "cf-aig-authorization",
      prefix: "Bearer ",
      secret: "AI_GATEWAY_API_KEY",
    },
    authOptional: true,
    docs: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
    api: "https://developers.cloudflare.com/ai-gateway/",
    setup: "setup/ai-gateway.md",
    origin: "https://gateway.ai.cloudflare.com",
    alsoNeeds: ["CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_ID"],
    basePath: "/v1/{CLOUDFLARE_ACCOUNT_ID}/{AI_GATEWAY_ID}",
    inferenceRoutes: [],
    hint: "The gateway's id from the AI Gateway page (everyapp ai gateway on makes one named everyapp); AI_GATEWAY_API_KEY only for an authenticated gateway, sent as cf-aig-authorization.",
    secrets: [
      {
        name: "AI_GATEWAY_ID",
        hint: "The AI Gateway's id (its name in the dashboard), in the Gateway's own Cloudflare account.",
      },
      {
        name: "AI_GATEWAY_API_KEY",
        hint: "An AI Gateway token with Run permission, only when the gateway is authenticated; leave unset for an open gateway.",
      },
    ],
    verified: { on: "2026-10-25", how: "docs" },
  },
  dataforseo: {
    mode: "api_key",
    label: "DataForSEO",
    description:
      "SEO data: keyword metrics, live search results, domain rankings, backlinks.",
    // The key is `login:password` as the dashboard shows them, or that pair
    // already base64-encoded (what OpenSEO's DATAFORSEO_API_KEY has always held).
    auth: { kind: "basic", secret: "DATAFORSEO_API_KEY", as: "pair" },
    docs: "https://app.dataforseo.com/api-access",
    api: "https://docs.dataforseo.com/v3/",
    setup: "setup/dataforseo.md",
    // The sandbox answers like production, with made-up data and no charge.
    hosts: ["api.dataforseo.com", "sandbox.dataforseo.com"],
    access: ["read"],
    // Every DataForSEO endpoint reads data, the paid live POSTs included;
    // none changes anything the organization owns.
    readMethods: ["GET", "POST"],
    // Results are fetched by task id, which only the app that posted the
    // task holds; these list every task (ready, or fixed within the last
    // week), error and setting on the account.
    accountWidePaths: [
      ["tasks_ready"],
      ["tasks_fixed"],
      ["id_list"],
      ["errors"],
      ["appendix", "user_data"],
      ["appendix", "webhook_resend"],
    ],
    hint: "The API login and password from API Access, as login:password (or that pair base64-encoded); the Gateway sends them as HTTP Basic.",
    secrets: [
      {
        name: "DATAFORSEO_API_KEY",
        hint: "login:password, or its base64; never the dashboard sign-in password.",
      },
    ],
    // DataForSEO's envelope starts with the call's cost in USD.
    cost: {
      unit: "call",
      responseField: "cost",
      note: "A Google SERP $0.002 per 10 results; a Labs task $0.012 plus $0.00012 per item.",
    },
    smoke: {
      method: "GET",
      path: "/v3/appendix/user_data",
      expect: [200],
      free: true,
      note: "Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.",
    },
    example: "find keyword ideas for a page about running shoes",
    verified: { on: "2026-10-25", how: "live" },
  },
  context: {
    mode: "api_key",
    label: "Context.dev",
    description: "Scrapes and renders web pages, JavaScript included.",
    auth: { kind: "bearer", secret: "CONTEXT_API_KEY" },
    docs: "https://context.dev/",
    setup: "setup/context.md",
    hosts: ["api.context.dev"],
    access: ["read"],
    // Scraping and rendering pages reads the web; nothing it owns changes.
    readMethods: ["GET", "POST"],
    accountWidePaths: [],
    hint: "An API key from the Context.dev dashboard; the Gateway puts it on every call as a bearer token.",
    verified: { on: "2026-10-25", how: "live" },
  },
  // Outbound mail through the gateway's own sender and transport
  // (apps/every-app-gateway/src/server/capabilities/email.ts): one sending
  // domain onboarded per gateway, its daily budgets, attribution and logs.
  email: {
    mode: "service",
    label: "Email",
    access: ["write"],
    routes: { send: ["POST"] },
    // The sender is EMAIL_FROM with a display name: the gateway refuses to
    // send without one. EMAIL_FROM_NAME is the plain way to give it, so the
    // setup dialog and the CLI name both; EMAIL_FROM="Name <address>" stays
    // accepted (parseEmailSender in internal/email.ts), and the gateway,
    // which reads values, answers by its own rule (isEmailConfigured: a
    // sender that parses and a provider that is selectable) rather than by
    // these names. The CLI reads names alone, so it calls EMAIL_FROM_NAME
    // unset until it is.
    settings: ["EMAIL_FROM", "EMAIL_FROM_NAME"],
    // The providers' settings (internal/email.ts chooseEmailProvider):
    // Cloudflare's REST pair, sent instead of the gateway's EMAIL binding
    // (a gateway outside Workers, local dev); Resend's key; and the choice
    // between them when both are set.
    optionalSettings: [
      "EMAIL_REST_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "RESEND_API_KEY",
      "EMAIL_PROVIDER",
    ],
    setup: "setup/email.md",
  },
  // The organization's members who can open the app
  // (apps/every-app-gateway/src/server/capabilities/members.ts): who an app
  // may email or notify now, after people leave or lose access. It needs no
  // setting; the gateway reads its own directory.
  members: {
    mode: "service",
    label: "Members",
    access: ["read"],
    routes: { list: ["GET"] },
    settings: [],
    optionalSettings: [],
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
    setup: "setup/slack.md",
    authorize: {
      url: "https://slack.com/oauth/v2/authorize",
      // The sets' union: the bot scopes in set order, then the one user
      // scope no bot set carries. Postiz lists `channels.read`,
      // `users.read`, `messages.write`, `channels.join` and `files.write`
      // (it posts to channels it joins and uploads images); Open CRM adds
      // `users.email`, `channels.manage` and `user-channels.manage` (its
      // team agents match members to Slack users by email, create and
      // manage the channels they post to, open DMs, and the installing
      // person invites the bot to private channels).
      scopes: [
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
      ],
    },
    scopePolicy: {
      dialect: "slack",
      // `oauth.v2.access` takes `code` with no `grant_type`; an app that
      // opts into token rotation refreshes with `refresh_token`.
      grantTypes: [null, "refresh_token"],
      // Slack reads no `scope` on the token leg (the installation's scopes
      // were fixed on the authorize URL), so the request goes as sent.
      requestScope: "keep",
      alwaysRequested: [],
      tolerated: [],
      deniedSegments: [],
      // Slack authorizes by method name, not verb, and every method is one
      // exact `/api/<method>` path on the host that also serves the token
      // endpoint (which no set lists). A read set names its methods in
      // `paths` (GET) and `posts` (POST) alike; a write set in `posts`
      // only, with the one listing among them in `paths` too.
      sets: {
        "channels.read": {
          label: "Channels (read-only)",
          access: "read",
          scopes: ["channels:read", "groups:read"],
          routes: [
            {
              host: "slack.com",
              paths: [
                "/api/conversations.list",
                "/api/conversations.info",
                "/api/conversations.members",
                "/api/users.conversations",
              ],
              posts: [
                /^\/api\/conversations\.(list|info|members)$/,
                /^\/api\/users\.conversations$/,
              ],
            },
          ],
        },
        "users.read": {
          label: "Members (read-only)",
          access: "read",
          scopes: ["users:read"],
          routes: [
            {
              host: "slack.com",
              paths: [
                "/api/users.list",
                "/api/users.info",
                "/api/users.getPresence",
                "/api/bots.info",
              ],
              posts: [
                /^\/api\/users\.(list|info|getPresence)$/,
                /^\/api\/bots\.info$/,
              ],
            },
          ],
        },
        "users.email": {
          // Slack grants it only beside `users:read`: declare both sets.
          label: "Members' email addresses (read-only)",
          access: "read",
          scopes: ["users:read.email"],
          routes: [
            {
              host: "slack.com",
              paths: ["/api/users.lookupByEmail"],
              posts: [/^\/api\/users\.lookupByEmail$/],
            },
          ],
        },
        "messages.write": {
          label: "Messages (post as the app)",
          access: "write",
          scopes: ["chat:write", "chat:write.public", "chat:write.customize"],
          routes: [
            {
              host: "slack.com",
              // The scheduled-messages listing is the one read among them.
              paths: ["/api/chat.scheduledMessages.list"],
              posts: [
                /^\/api\/chat\.(postMessage|postEphemeral|update|delete|scheduleMessage|deleteScheduledMessage|scheduledMessages\.list)$/,
              ],
            },
          ],
        },
        "channels.join": {
          label: "Channels (join public ones)",
          access: "write",
          scopes: ["channels:join"],
          routes: [
            {
              host: "slack.com",
              paths: [],
              posts: [/^\/api\/conversations\.join$/],
            },
          ],
        },
        "channels.manage": {
          label: "Channels (create, manage and invite to; open DMs)",
          access: "write",
          scopes: [
            "channels:manage",
            "groups:write",
            "channels:write.invites",
            "groups:write.invites",
            "im:write",
          ],
          routes: [
            {
              host: "slack.com",
              paths: [],
              posts: [
                /^\/api\/conversations\.(create|rename|archive|unarchive|invite|open|kick|leave|setTopic|setPurpose|mark)$/,
              ],
            },
          ],
        },
        "files.write": {
          label: "Files (upload)",
          access: "write",
          scopes: ["files:write"],
          routes: [
            {
              host: "slack.com",
              paths: [],
              // The external upload flow; the retired `files.upload` stays off.
              posts: [
                /^\/api\/files\.(getUploadURLExternal|completeUploadExternal)$/,
              ],
            },
          ],
        },
        "user-channels.manage": {
          label: "Channels (as the installing person: read, manage, invite to)",
          access: "write",
          scopes: [],
          // Slack's `user_scope`: issued to the person's own token, which
          // Open CRM uses to invite the bot to private channels.
          userScopes: [
            "channels:read",
            "channels:write",
            "groups:read",
            "groups:write",
          ],
          routes: [
            {
              host: "slack.com",
              paths: [
                "/api/conversations.list",
                "/api/conversations.info",
                "/api/conversations.members",
                "/api/users.conversations",
              ],
              posts: [
                /^\/api\/conversations\.(list|info|members|create|rename|archive|unarchive|invite|kick|leave|setTopic|setPurpose|mark)$/,
                /^\/api\/users\.conversations$/,
              ],
            },
          ],
        },
      },
    },
    api: ["slack.com"],
    // Slack refuses `code_challenge`; `auth.test` names the workspace and
    // the installing person.
    flow: {
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      revokeUrl: "https://slack.com/api/auth.revoke",
      pkce: false,
      scopeDialect: "slack",
      identity: {
        url: "https://slack.com/api/auth.test",
        label: "team",
        id: "user_id",
      },
    },
  },
  // Clients several apps share with different needs, so each app lists the
  // scope sets it uses: Open CRM reads a member's own mailbox and calendar
  // (`gmail.read`, `calendar.read`; `identity`, `mail.read`), OpenSEO reads
  // a site's Search Console and Analytics (`identity`, `search-console.read`,
  // `analytics.read`). Every set is read-only. Google's is one Cloud project
  // apart from the YouTube preset's; Gmail's read scope is restricted and needs
  // Google's verification, and whether Search Console and Analytics share
  // that consent screen with it is the operator's choice when verifying.
  "google-workspace": {
    mode: "oauth_client",
    label: "Google (Gmail, Calendar, Search Console and Analytics)",
    secrets: {
      clientId: "GOOGLE_WORKSPACE_CLIENT_ID",
      clientSecret: "GOOGLE_WORKSPACE_CLIENT_SECRET",
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
    setup: "setup/google.md",
    authorize: {
      url: "https://accounts.google.com/o/oauth2/v2/auth",
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/webmasters.readonly",
        "https://www.googleapis.com/auth/analytics.readonly",
      ],
    },
    scopePolicy: {
      dialect: "google",
      // Google documents no scope on either token leg: the response's
      // `scope` is where the gateway learns what a token holds.
      grantTypes: ["authorization_code", "refresh_token"],
      requestScope: "drop",
      alwaysRequested: [],
      // Both spellings: Google documents `email`/`profile` and the userinfo
      // URLs as the same grants, and echoes the URLs.
      tolerated: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
      // Gmail's and Calendar's `/batch/<api>/<version>` carry whole requests
      // inside; Analytics' measurement protocol secrets are readable under
      // the read-only scope.
      deniedSegments: ["batch", "measurementProtocolSecrets"],
      sets: {
        identity: {
          label: "Google account (who you are)",
          access: "read",
          scopes: ["openid", "email", "profile"],
          routes: [
            { host: "openidconnect.googleapis.com", paths: ["/v1/userinfo"] },
            {
              host: "www.googleapis.com",
              paths: [
                "/oauth2/v2/userinfo",
                "/oauth2/v3/userinfo",
                "/userinfo/v2/me",
              ],
            },
          ],
        },
        "gmail.read": {
          label: "Gmail (read-only)",
          access: "read",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          routes: [
            {
              host: "gmail.googleapis.com",
              paths: ["/gmail/v1/users/"],
              // Push notifications start and stop; `messages/send`, drafts
              // and `modify` are the other POSTs under the same prefix.
              posts: [/^\/gmail\/v1\/users\/[^/]+\/(watch|stop)$/],
            },
          ],
        },
        "calendar.read": {
          label: "Google Calendar (read-only)",
          access: "read",
          scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
          routes: [
            {
              host: "www.googleapis.com",
              paths: ["/calendar/v3/"],
              posts: [
                /^\/calendar\/v3\/freeBusy$/,
                /^\/calendar\/v3\/calendars\/[^/]+\/events\/watch$/,
                /^\/calendar\/v3\/users\/me\/calendarList\/watch$/,
                /^\/calendar\/v3\/channels\/stop$/,
              ],
            },
          ],
        },
        "search-console.read": {
          label: "Search Console (read-only)",
          access: "read",
          scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
          // The v3 paths answer on both hosts; URL inspection is v1 only.
          // A site is one segment, `https%3A%2F%2Fexample.com%2F` or
          // `sc-domain%3Aexample.com`, which is why routes match the raw path.
          routes: [
            {
              host: "www.googleapis.com",
              paths: ["/webmasters/v3/"],
              posts: [
                /^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/,
              ],
            },
            {
              host: "searchconsole.googleapis.com",
              paths: ["/webmasters/v3/"],
              posts: [
                /^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/,
                /^\/v1\/urlInspection\/index:inspect$/,
              ],
            },
          ],
        },
        "analytics.read": {
          label: "Google Analytics (read-only)",
          access: "read",
          scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
          routes: [
            {
              // Reports are POSTed queries.
              host: "analyticsdata.googleapis.com",
              paths: ["/v1beta/properties/"],
              posts: [
                /^\/v1beta\/properties\/[^/]+:(runReport|batchRunReports|runPivotReport|batchRunPivotReports|runRealtimeReport|checkCompatibility)$/,
              ],
            },
            {
              // Reads only: accounts, properties and what hangs off them
              // (data streams, key events, enhanced measurement settings).
              host: "analyticsadmin.googleapis.com",
              paths: [
                "/v1beta/accountSummaries",
                "/v1beta/accounts",
                "/v1beta/accounts/",
                "/v1beta/properties",
                "/v1beta/properties/",
                "/v1alpha/properties/",
              ],
            },
          ],
        },
      },
    },
    api: [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "searchconsole.googleapis.com",
      "analyticsdata.googleapis.com",
      "analyticsadmin.googleapis.com",
      "openidconnect.googleapis.com",
    ],
    // The Gateway-owned flow: a refresh token needs `access_type=offline`,
    // and `prompt=consent` makes Google issue one on every connect. No
    // revoke: Google's `/revoke` is per person per client and would also
    // kill the tokens an app-driven OpenSEO holds under the same client.
    flow: {
      tokenUrl: "https://oauth2.googleapis.com/token",
      pkce: true,
      scopeDialect: "google",
      authorizeParams: { access_type: "offline", prompt: "consent" },
      identity: {
        url: "https://openidconnect.googleapis.com/v1/userinfo",
        label: "email",
        id: "sub",
      },
    },
  },
  "microsoft-365": {
    mode: "oauth_client",
    label: "Microsoft 365 (Outlook mail and calendar)",
    secrets: {
      clientId: "MICROSOFT_365_CLIENT_ID",
      clientSecret: "MICROSOFT_365_CLIENT_SECRET",
    },
    token: [
      {
        // The multi-tenant endpoint: register the client for accounts in
        // any organization and personal accounts. A single-tenant client
        // answers only on its tenant's path, which this does not complete.
        host: "login.microsoftonline.com",
        path: "/common/oauth2/v2.0/token",
        methods: ["POST"],
        inject: "form",
      },
    ],
    access: ["write"],
    console:
      "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    setup: "setup/microsoft-365.md",
    authorize: {
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      scopes: ["offline_access", "User.Read", "Mail.Read", "Calendars.Read"],
    },
    scopePolicy: {
      dialect: "microsoft",
      grantTypes: ["authorization_code", "refresh_token"],
      // The token leg's `scope` is Microsoft's extension for naming the
      // resource; the gateway sets it to the app's list so a token covers
      // Graph alone.
      requestScope: "replace",
      // Refresh tokens; Entra never echoes it in a response's `scope`.
      alwaysRequested: ["offline_access"],
      // Compared case-insensitively, as Microsoft spells them both ways.
      tolerated: ["openid", "profile", "email", "offline_access", "User.Read"],
      // `$batch` carries whole requests inside; `beta` is another API.
      deniedSegments: ["$batch", "beta"],
      // `/v1.0/me/…` only: `/v1.0/users/<id>/…` reaches shared mailboxes
      // and calendars under the same permissions.
      sets: {
        identity: {
          label: "Microsoft account (who you are)",
          access: "read",
          scopes: ["User.Read"],
          routes: [
            {
              host: "graph.microsoft.com",
              paths: ["/v1.0/me", "/oidc/userinfo"],
            },
          ],
        },
        "mail.read": {
          label: "Outlook mail (read-only)",
          access: "read",
          scopes: ["Mail.Read"],
          routes: [
            {
              host: "graph.microsoft.com",
              paths: [
                "/v1.0/me/messages",
                "/v1.0/me/messages/",
                "/v1.0/me/mailFolders",
                "/v1.0/me/mailFolders/",
              ],
            },
          ],
        },
        "calendar.read": {
          label: "Outlook calendar (read-only)",
          access: "read",
          scopes: ["Calendars.Read"],
          routes: [
            {
              host: "graph.microsoft.com",
              paths: [
                "/v1.0/me/calendar",
                "/v1.0/me/calendar/",
                "/v1.0/me/calendars",
                "/v1.0/me/calendars/",
                "/v1.0/me/events",
                "/v1.0/me/events/",
                "/v1.0/me/calendarView",
                "/v1.0/me/calendarView/",
              ],
              // Free/busy is a POSTed query.
              posts: [/^\/v1\.0\/me\/calendar\/getSchedule$/],
            },
          ],
        },
      },
    },
    api: ["graph.microsoft.com"],
    flow: {
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      pkce: true,
      scopeDialect: "microsoft",
      identity: {
        url: "https://graph.microsoft.com/v1.0/me",
        label: "userPrincipalName",
        id: "id",
      },
    },
  },
  // The first fifty beyond the entries above (catalog/*.ts, PR 3 of the
  // provider registry), after them so the derived lists keep their order.
  ...CATALOG_ENTRIES,
} as const satisfies Record<string, Capability>;

export type CapabilityId = keyof typeof CAPABILITIES;

type CapabilityIdOf<Mode extends Capability["mode"]> = {
  [K in CapabilityId]: (typeof CAPABILITIES)[K]["mode"] extends Mode
    ? K
    : never;
}[CapabilityId];

/** Capabilities an app calls with `integrationFetch()`: providers whose key the gateway holds. */
export type ApiKeyCapabilityId = CapabilityIdOf<"api_key">;

/** The AI providers an app lists under `providers` and calls with `createGatewayFetch()`. */
export type AiProviderId = CapabilityIdOf<"ai">;

/** Capabilities the gateway performs itself, each with its SDK helper. */
export type ServiceCapabilityId = CapabilityIdOf<"service">;

/** OAuth clients whose token endpoints apps reach with `integrationFetch()`. */
export type OAuthClientCapabilityId = CapabilityIdOf<"oauth_client">;

/**
 * The scope set names an OAuth client offers; `never` for a client without
 * a scope policy. Distributes over a union of ids, so a generic over two
 * clients gets every name either offers rather than the names they share.
 */
export type OAuthScopeSetName<Id extends OAuthClientCapabilityId> =
  Id extends unknown
    ? (typeof CAPABILITIES)[Id] extends { scopePolicy: { sets: infer S } }
      ? keyof S & string
      : never
    : never;

/** The Gateway settings an `auth` block names: the key, and a Basic username held as a setting. */
type AuthSettingsOf<A> =
  | (A extends { secret: infer S extends string } ? S : never)
  | (A extends { user: { secret: infer U extends string } } ? U : never);

type SettingsOf<C> = C extends {
  settings: readonly (infer S extends string)[];
  optionalSettings: readonly (infer O extends string)[];
}
  ? S | O
  : C extends { secrets: infer S; token: unknown }
    ? S[keyof S] & string
    : C extends { auth: infer A }
      ?
          | AuthSettingsOf<A>
          | (C extends { alsoNeeds: readonly (infer N extends string)[] }
              ? N
              : never)
      : never;

/** The gateway settings capabilities read: keys, clients, senders, transports. */
export type CapabilitySecret = SettingsOf<(typeof CAPABILITIES)[CapabilityId]>;

/** The Gateway settings an API-key or AI provider's `auth` names: the key first, then a Basic username held as a setting. */
export function authSettingNames(auth: ApiKeyAuth): string[] {
  const names = [auth.secret];
  if (
    auth.kind === "basic" &&
    auth.as === "password" &&
    typeof auth.user === "object"
  ) {
    names.push(auth.user.secret);
  }
  return names;
}

/** Every gateway setting `capability` reads, the ones it needs first. */
export function capabilitySettings(capability: Capability): readonly string[] {
  switch (capability.mode) {
    case "api_key":
      return [
        ...authSettingNames(capability.auth),
        ...(capability.hostSetting ? [capability.hostSetting] : []),
      ];
    case "ai":
      return [capability.auth.secret, ...(capability.alsoNeeds ?? [])];
    case "service":
      return [...capability.settings, ...capability.optionalSettings];
    case "oauth_client":
      return [
        capability.secrets.clientId,
        ...(capability.secrets.clientSecret
          ? [capability.secrets.clientSecret]
          : []),
      ];
  }
}

export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[];

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && Object.hasOwn(CAPABILITIES, value);
}

/**
 * Where a provider id is looked up: the built-in catalog alone
 * ({@link CATALOG}), or the catalog and one gateway's registered rows
 * (`providerRegistry()` in ./providerRegistry.ts). Everything that brokers,
 * validates or describes a provider takes one, so a registered row is a
 * provider wherever a catalog entry is.
 */
export interface CapabilityLookup {
  get(id: string): Capability | undefined;
  /** Every id, in order: the catalog's, then a gateway's rows. */
  ids(): readonly string[];
  /**
   * Whether `id`'s settings may be read now: a registered row's only while
   * its key was set for the hosts and auth it has (the registry's rule);
   * absent, as for the catalog alone, every entry's may.
   */
  bound?(id: string): boolean;
}

/** The built-in catalog as a lookup: what every surface reads without a gateway's rows. */
export const CATALOG: CapabilityLookup = {
  get: (id) => (isCapabilityId(id) ? CAPABILITIES[id] : undefined),
  ids: () => CAPABILITY_IDS,
};

/** The ids an app may list under `capabilities`: every provider but the AI ones, which go under `providers`. */
export function capabilityIdsOf(lookup: CapabilityLookup): string[] {
  return lookup.ids().filter((id) => lookup.get(id)?.mode !== "ai");
}

/**
 * The settings `capability` needs on a request, read from the Gateway's
 * settings (or `.dev.vars`): the headers to set and the query parameters
 * to add, or null while any setting its `auth` names is unset or blank.
 * Values are trimmed. A Basic key without a username is `login:password`
 * to encode, or taken as already encoded when it holds no colon.
 */
export function authorizationFor(
  capability: ApiKeyCapability | AiProviderCapability,
  settings: CapabilitySettings,
): Authorization | null {
  return authorizationOf(capability.auth, settings);
}

/** What {@link authorizationFor} puts on a request. */
export interface Authorization {
  headers: Record<string, string>;
  query: Record<string, string>;
}

/** {@link authorizationFor} for an `auth` block alone (the SDK's AI fallback holds the block, not the entry). */
export function authorizationOf(
  auth: ApiKeyAuth,
  settings: CapabilitySettings,
): Authorization | null {
  const key = settingValue(settings[auth.secret]);
  if (!key) return null;
  switch (auth.kind) {
    case "bearer":
      return {
        headers: { authorization: `${auth.scheme ?? "Bearer"} ${key}` },
        query: {},
      };
    case "header":
      return {
        headers: { [auth.header.toLowerCase()]: `${auth.prefix ?? ""}${key}` },
        query: {},
      };
    case "query":
      return { headers: {}, query: { [auth.param]: key } };
    case "basic": {
      const basic = (credentials: string) => ({
        headers: { authorization: `Basic ${credentials}` },
        query: {},
      });
      if (auth.as === "pair") return basic(basicCredentials(key));
      if (auth.as === "username") return basic(base64Utf8(`${key}:`));
      const user =
        typeof auth.user === "string"
          ? auth.user
          : settingValue(settings[auth.user.secret]);
      if (!user) return null;
      return basic(base64Utf8(`${user}:${key}`));
    }
  }
}

function settingValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The host a provider's `hostSetting` names, from its value: a bare host
 * or an https origin with nothing else (no path, port, query, userinfo),
 * lowercased; null when unset or not of that shape. The host rules a row
 * must pass apply to it when the registry reads the row.
 */
export function hostSettingValue(value: unknown): string | null {
  const text = settingValue(value);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
    );
  } catch {
    return null;
  }
  const bare =
    url.protocol === "https:" &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    !url.port &&
    !text.endsWith("/");
  return bare ? url.hostname.toLowerCase() : null;
}

/**
 * The hosts an API-key provider's key may be sent to: the entry's own,
 * and the one its `hostSetting` names when that is set and well-formed.
 */
export function apiKeyHosts(
  capability: ApiKeyCapability,
  settings?: CapabilitySettings,
): string[] {
  const named = capability.hostSetting
    ? hostSettingValue(settings?.[capability.hostSetting])
    : null;
  return [...capability.hosts, ...(named ? [named] : [])];
}

/** Where AppGateway serves capability calls. */
export const INTEGRATION_PROXY_PREFIX = "/api/integrations";

/**
 * The AppGateway path for a call to `upstream`:
 * `/api/integrations/<id>/<host><path>?<query>`. The host is in the path so
 * a provider with several API hosts needs no other channel.
 */
export function integrationProxyPath(
  id: ApiKeyCapabilityId | OAuthClientCapabilityId | (string & {}),
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
  | { kind: "api_key"; id: string; capability: ApiKeyCapability; upstream: URL }
  /** A call to one of an OAuth client's token endpoints, with its rule. */
  | {
      kind: "oauth_client";
      id: string;
      capability: OAuthClientCapability;
      upstream: URL;
      endpoint: OAuthTokenEndpoint;
    }
  /** A call to one of the routes a service capability declares. */
  | {
      kind: "service";
      id: ServiceCapabilityId;
      capability: GatewayServiceCapability;
      route: string;
    };

/** Gateway settings by name: the gateway's env, or `.dev.vars` in dev. */
export type CapabilitySettings = Readonly<Record<string, unknown>>;

/**
 * The capability call an AppGateway path names, or null when the path names
 * an unknown capability (or an AI provider, which has its own route), a
 * host outside the provider's, a path that could leave that host, a path
 * that isn't one of an OAuth client's token endpoints, or a route a service
 * capability doesn't declare. `settings` resolves an API-key provider's
 * `hostSetting` (a Shopify store's host); `lookup` is where the id is found,
 * the catalog alone by default.
 */
export function parseIntegrationProxyPath(
  pathname: string,
  search: string,
  settings?: CapabilitySettings,
  lookup: CapabilityLookup = CATALOG,
): IntegrationProxyRoute | null {
  const match = /^\/api\/integrations\/([a-z][a-z0-9-]*)\/([^/]+)(\/.*)?$/.exec(
    pathname,
  );
  if (!match) return null;
  const [, id = "", host = "", path] = match;
  const capability = lookup.get(id);
  if (!capability) return null;
  if (capability.mode === "service") {
    // A route is one segment; nothing may follow it.
    if (path !== undefined || !Object.hasOwn(capability.routes, host)) {
      return null;
    }
    return {
      kind: "service",
      id: id as ServiceCapabilityId,
      capability,
      route: host,
    };
  }
  if (capability.mode === "oauth_client") {
    const upstream = capability.token.some((rule) => rule.host === host)
      ? httpsUpstream(host, path ?? "/", search)
      : null;
    const endpoint = upstream && tokenEndpointFor(capability, upstream);
    if (!upstream || !endpoint) return null;
    return { kind: "oauth_client", id, capability, upstream, endpoint };
  }
  if (capability.mode !== "api_key") return null;
  const upstream = apiKeyHosts(capability, settings).includes(host)
    ? httpsUpstream(host, path ?? "/", search)
    : null;
  if (!upstream) return null;
  return { kind: "api_key", id, capability, upstream };
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
 * The token endpoint `upstream` is, by its exact host and path, or null.
 * Its method is the caller's to check.
 */
export function tokenEndpointFor(
  capability: OAuthClientCapability,
  upstream: URL,
): OAuthTokenEndpoint | null {
  if (upstream.protocol !== "https:") return null;
  return (
    capability.token.find(
      ({ host, path }) => host === upstream.host && path === upstream.pathname,
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
        `${methods.join("/")} https://${host}${path}`,
    )
    .join(", ");
}

/**
 * The command that gives the gateway `capability`'s client:
 * `pnpm everyapp secret set <ID> <SECRET>`.
 */
export function oauthClientSecretSetCommand(
  capability: OAuthClientCapability,
): string {
  return `pnpm everyapp secret set ${capabilitySettings(capability).join(" ")}`;
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
 * A Basic credential held as one setting: `login:password` as a dashboard
 * shows them, or the pair already base64-encoded (DataForSEO's rule, and
 * what OpenSEO's DATAFORSEO_API_KEY has always held). A base64 string never
 * holds a colon, so the colon decides.
 */
function basicCredentials(key: string): string {
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
