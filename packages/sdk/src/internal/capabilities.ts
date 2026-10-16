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
   * Paths no app may reach, matched against the upstream pathname decoded
   * and lowercased (see {@link isAccountWidePath}). One key
   * serves every app in every organization, so endpoints that list or
   * describe the whole provider account would show one app another's work.
   */
  accountWidePaths: readonly RegExp[];
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
      /\/(tasks_ready|id_list|errors)([/;.]|$)/,
      /\/appendix\/(user_data|webhook_resend)([/;.]|$)/,
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

/**
 * Whether `pathname` reaches one of the capability's account-wide paths,
 * however it is spelled: percent-encoded, in another case, or with a
 * trailing segment. A path that doesn't decode counts as one.
 */
export function isAccountWidePath(
  capability: ApiKeyCapability,
  pathname: string,
): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).toLowerCase();
  } catch {
    return true;
  }
  return capability.accountWidePaths.some((pattern) => pattern.test(decoded));
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
