/**
 * Capabilities the gateway holds for apps (docs/capabilities.md), phase 0:
 * API-key providers. The operator sets a provider's key once on the gateway
 * (`everyapp secret set <secret> --for gateway`), an app lists the provider
 * in its manifest's `capabilities`, and the app calls the provider through
 * the AppGateway binding (`integrationFetch()`), so no app ever holds the
 * key.
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
} as const satisfies Record<string, ApiKeyCapability>;

export type CapabilityId = keyof typeof CAPABILITIES;

/** The gateway secrets that hold capability keys. */
export type CapabilitySecret = (typeof CAPABILITIES)[CapabilityId]["secret"];

export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[];

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && Object.hasOwn(CAPABILITIES, value);
}

/** Where AppGateway serves calls to API-key capabilities. */
export const INTEGRATION_PROXY_PREFIX = "/api/integrations";

/**
 * The AppGateway path for a call to `upstream`:
 * `/api/integrations/<id>/<host><path>?<query>`. The host is in the path so
 * a provider with several API hosts needs no other channel.
 */
export function integrationProxyPath(id: CapabilityId, upstream: URL): string {
  return `${INTEGRATION_PROXY_PREFIX}/${id}/${upstream.host}${upstream.pathname}${upstream.search}`;
}

/**
 * The capability and upstream URL an AppGateway path names, or null when
 * the path names an unknown capability, a host outside the provider's, or a
 * path that could leave that host.
 */
export function parseIntegrationProxyPath(
  pathname: string,
  search: string,
): { id: CapabilityId; upstream: URL } | null {
  const match = /^\/api\/integrations\/([a-z][a-z0-9-]*)\/([^/]+)(\/.*)?$/.exec(
    pathname,
  );
  if (!match) return null;
  const [, id, host, path = "/"] = match;
  if (!isCapabilityId(id)) return null;
  if (!(CAPABILITIES[id].hosts as readonly string[]).includes(host ?? "")) {
    return null;
  }
  if (path.startsWith("//") || path.includes("\\")) return null;
  const upstream = new URL(`https://${host}${path}${search}`);
  // A parser quirk must never move the key to another host.
  if (upstream.host !== host || upstream.protocol !== "https:") return null;
  return { id, upstream };
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
