/**
 * Capabilities the gateway holds for apps (docs/capabilities.md), of two
 * kinds:
 *
 *  - `api_key`: a provider whose key the gateway holds. The operator sets
 *    the key once on the gateway (`everyapp secret set <secret> --for
 *    gateway`), an app lists the provider in its manifest's `capabilities`,
 *    and the app calls the provider through the AppGateway binding
 *    (`integrationFetch()`), so no app ever holds the key.
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

export type Capability = ApiKeyCapability | GatewayServiceCapability;

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

type SettingsOf<C> = C extends { secret: infer S extends string }
  ? S
  : C extends {
        settings: readonly (infer S extends string)[];
        optionalSettings: readonly (infer O extends string)[];
      }
    ? S | O
    : never;

/** The gateway settings capabilities read: keys, senders, transports. */
export type CapabilitySecret = SettingsOf<(typeof CAPABILITIES)[CapabilityId]>;

/** Every gateway setting `capability` reads, the ones it needs first. */
export function capabilitySettings(capability: Capability): readonly string[] {
  return capability.mode === "api_key"
    ? [capability.secret]
    : [...capability.settings, ...capability.optionalSettings];
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
  id: ApiKeyCapabilityId,
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
  /** A call to one of the routes a service capability declares. */
  | { kind: "service"; id: ServiceCapabilityId; route: string };

/**
 * The capability call an AppGateway path names, or null when the path names
 * an unknown capability, a host outside the provider's, a path that could
 * leave that host, or a route a service capability doesn't declare.
 */
export function parseIntegrationProxyPath(
  pathname: string,
  search: string,
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
  return apiKeyRoute(id as ApiKeyCapabilityId, host, path ?? "/", search);
}

function apiKeyRoute(
  id: ApiKeyCapabilityId,
  host: string,
  path: string,
  search: string,
): IntegrationProxyRoute | null {
  if (!(CAPABILITIES[id].hosts as readonly string[]).includes(host)) {
    return null;
  }
  if (path.startsWith("//") || path.includes("\\")) return null;
  const upstream = new URL(`https://${host}${path}${search}`);
  // A parser quirk must never move the key to another host.
  if (upstream.host !== host || upstream.protocol !== "https:") return null;
  return { kind: "api_key", id, upstream };
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
  if (!trimmed.includes(":")) return trimmed;
  let binary = "";
  for (const byte of new TextEncoder().encode(trimmed)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
