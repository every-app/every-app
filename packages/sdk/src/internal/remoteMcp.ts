/**
 * Remote MCP apps: any remote MCP server registered on a gateway by URL
 * (`everyapp mcp add <url>`, Admin → Apps → Add app → "Add an MCP server",
 * `everyapp_mcp_add`), served to members' AI clients as an MCP app of the
 * Gateway's own, like a built-in provider app (./providerApps.ts) but with
 * its tools read from the server and each call forwarded to it
 * (docs/design/2026-10-mcp-by-url.md, docs/design/2026-11-mcp-apps-auth.md).
 *
 * The registration record is the app row's manifest: `id`, `name`,
 * `description` and a `remote` block ({@link RemoteMcpBlock}): the one URL
 * the Gateway ever fetches, its credential ({@link RemoteMcpAuth}: none, or
 * a provider of the registry, whose key or OAuth connection the Gateway
 * holds and binds to the provider's hosts), how a tool's risk is decided
 * when the server's annotations don't say, the operator's per-tool
 * overrides, and a revision the writers bump so the Gateway re-lists the
 * tools on first use after a change. An app with a provider also lists it
 * under `capabilities` ({@link remoteMcpAppManifest}), so the settings
 * model treats its key or client as any app's.
 *
 * A credential the registrar gives at `mcp add` becomes a provider row of
 * the app's own, `<appId>-mcp` ({@link remoteMcpProviderId}; the specs are
 * built in ./mcpOAuth.ts): an API-key row for a static value
 * (`<APPID>_MCP_TOKEN`), a discovered `oauth2-user` row for OAuth
 * (`<APPID>_MCP_CLIENT_ID`, `_SECRET`).
 *
 * Everything here is pure and shared by the CLI, the perimeter's registry
 * rules, the Gateway (which serves the row and validates again at every
 * fetch) and the settings model (./appSettings.ts), so the rules cannot
 * drift: what the URL may be, what the credential may be, how a server's
 * tool names become the ToolBus's, and what risk a tool gets.
 */
import {
  CAPABILITIES,
  apiKeyHosts,
  type Capability,
  type CapabilitySettings,
} from "./capabilities.js";
import { isProviderAppId } from "./providerApps.js";
import { PROVIDER_ID } from "./providerSpec.js";
import { TOOL_NAME_PATTERN, isToolRisk, type ToolRisk } from "./tools.js";

/** The kinds a stored `remote.auth` block may have. */
export const REMOTE_MCP_AUTH_KINDS = ["none", "provider"] as const;
export type RemoteMcpAuthKind = (typeof REMOTE_MCP_AUTH_KINDS)[number];

/**
 * How the Gateway authenticates to the server: nothing, or a provider of
 * the registry (a catalog entry such as `elevenlabs`, a registered row, or
 * the row `everyapp mcp add` synthesizes for the app,
 * {@link remoteMcpProviderId}). The credential lives with the provider and
 * is bound to its hosts (`providers.value-bound-to-hosts`); the block only
 * names it. With an OAuth provider each member connects their own
 * account in the app.
 */
export type RemoteMcpAuth =
  | { kind: "none" }
  | { kind: "provider"; provider: string };

/**
 * What the registrar may ask for at `mcp add` (`--auth`): none, a static
 * credential the add turns into a synthesized API-key provider row, or
 * OAuth, a discovered `oauth2-user` row (./mcpOAuth.ts).
 */
export const REMOTE_MCP_CREDENTIAL_KINDS = [
  "none",
  "bearer",
  "header",
  "query",
  "basic",
  "oauth",
] as const;
export type RemoteMcpCredentialKind =
  (typeof REMOTE_MCP_CREDENTIAL_KINDS)[number];
/** The static credential kinds: one value, placed as the synthesized row's `auth` says. */
export type RemoteMcpStaticKind = Exclude<
  RemoteMcpCredentialKind,
  "none" | "oauth"
>;

/** Why an old registration (`bearer`, `header`, `basic`, `oauth` with a `secret`) no longer parses. */
export const REMOTE_MCP_AUTH_PREDATES =
  "this registration predates provider credentials; remove it and add it again";

/**
 * How a tool's risk is decided for the app. `annotations`: from the
 * server's hints ({@link remoteToolRisk}); `read` or `write`: every tool,
 * whatever it says. A per-tool override wins over all three.
 */
export const REMOTE_MCP_RISK_DEFAULTS = [
  "annotations",
  "read",
  "write",
] as const;
export type RemoteMcpRiskDefault = (typeof REMOTE_MCP_RISK_DEFAULTS)[number];

/** The operator's say about one tool, keyed by the server's own tool name. */
export interface RemoteMcpToolOverride {
  risk?: ToolRisk;
  /** False: left out of the Gateway's catalog; a call answers Unknown tool. */
  enabled?: boolean;
}

export interface RemoteMcpBlock {
  /** The one address the Gateway fetches and sends the credential to. */
  url: string;
  auth: RemoteMcpAuth;
  risk: RemoteMcpRiskDefault;
  tools: Record<string, RemoteMcpToolOverride>;
  /** Bumped on every change of the block, so the snapshot re-lists. */
  rev: number;
}

/** The manifest a remote MCP app's row stores. */
export interface RemoteMcpManifest {
  id: string;
  name: string;
  description: string;
  remote: RemoteMcpBlock;
  /** The provider the app's credential is, listed as a deployed app lists one ({@link remoteMcpAppManifest}). */
  capabilities?: Record<string, RemoteMcpCapabilityEntry>;
}

/** The manifest fields the Gateway reads, as a stored manifest has them. */
export interface RemoteMcpManifestLike {
  readonly remote?: unknown;
}

const ID_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const ID_MAX_LENGTH = 32;
/** App ids a remote server can't take: the Gateway's own tool prefix. */
const RESERVED_IDS: readonly string[] = ["everyapp"];
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const URL_MAX_LENGTH = 2048;
const NAME_MAX_LENGTH = 255;
const DESCRIPTION_MAX_LENGTH = 1000;
const OVERRIDES_MAX = 500;
const UPSTREAM_NAME_MAX = 256;

/**
 * Headers a static `header` credential may not name: the ones the Gateway
 * sets on the request, the ones that route it, and the ones that would
 * carry something other than this app's credential (`Authorization` is
 * the `bearer` kind's; `--prefix` gives it another scheme).
 */
const FORBIDDEN_AUTH_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "host",
  "content-type",
  "content-length",
  "accept",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "last-event-id",
]);

/**
 * Why `header` can't carry a remote MCP server's static credential, or
 * null when it can: an HTTP header name the MCP transport and the Gateway
 * don't set themselves.
 */
export function remoteMcpHeaderProblem(header: unknown): string | null {
  if (typeof header !== "string" || !HEADER_NAME_PATTERN.test(header)) {
    return "the header must be an HTTP header name";
  }
  if (FORBIDDEN_AUTH_HEADERS.has(header.toLowerCase())) {
    return `the header can't be ${header}; use --auth bearer for Authorization`;
  }
  return null;
}

/** The settings prefix of an app id's synthesized row: `my-server` → `MY_SERVER_MCP_`. */
function settingsPrefix(appId: string): string {
  return `${appId.toUpperCase().replace(/-/g, "_")}_MCP_`;
}

/**
 * The provider row `everyapp mcp add` writes for an app's own credential:
 * `<appId>-mcp` (`treg` → `treg-mcp`), its settings `TREG_MCP_*`.
 */
export function remoteMcpProviderId(appId: string): string {
  return `${appId}-mcp`;
}

/** Whether `providerId` is `appId`'s synthesized row ({@link remoteMcpProviderId}). */
export function isRemoteMcpProviderIdOf(
  providerId: string,
  appId: string,
): boolean {
  return providerId === remoteMcpProviderId(appId);
}

/** The static credential's setting on the synthesized row: `treg` → `TREG_MCP_TOKEN`. */
export function remoteMcpTokenSetting(appId: string): string {
  return `${settingsPrefix(appId)}TOKEN`;
}

/** The OAuth client id's setting on the synthesized row: `treg` → `TREG_MCP_CLIENT_ID`. */
export function remoteMcpClientIdSetting(appId: string): string {
  return `${settingsPrefix(appId)}CLIENT_ID`;
}

/** The OAuth client secret's setting on the synthesized row: `treg` → `TREG_MCP_CLIENT_SECRET`. */
export function remoteMcpClientSecretSetting(appId: string): string {
  return `${settingsPrefix(appId)}CLIENT_SECRET`;
}

/**
 * The redirect URI of an app's synthesized OAuth row, what a server's
 * client is registered with: `<gateway origin>/connect/<appId>-mcp/callback`.
 */
export function remoteMcpRedirectUri(
  gatewayUrl: string,
  appId: string,
): string {
  let origin = gatewayUrl.trim().replace(/\/+$/, "");
  try {
    origin = new URL(gatewayUrl).origin;
  } catch {
    // Not a URL: used as given, without a trailing slash.
  }
  return `${origin}/connect/${remoteMcpProviderId(appId)}/callback`;
}

/** Where the Gateway serves its OAuth client metadata documents (public, bypassed behind Access). */
export const REMOTE_MCP_CLIENT_METADATA_PREFIX = "/oauth-clients/";

/**
 * The Gateway's client id at a server that takes OAuth client ID metadata
 * documents (CIMD) instead of registration: the URL of the document that
 * describes the client, `<gateway origin>/oauth-clients/<appId>-mcp`.
 * Null for a Gateway that isn't on https (a local one): an authorization
 * server fetches the document, and only from https.
 */
export function remoteMcpClientMetadataUrl(
  gatewayUrl: string,
  appId: string,
): string | null {
  let origin: string;
  try {
    const parsed = new URL(gatewayUrl);
    if (parsed.protocol !== "https:") return null;
    origin = parsed.origin;
  } catch {
    return null;
  }
  return `${origin}${REMOTE_MCP_CLIENT_METADATA_PREFIX}${remoteMcpProviderId(appId)}`;
}

/**
 * The hosts a provider sends its credential to, the hosts an MCP URL
 * using it must be on: an API-key provider's `hosts` (and its host
 * setting's value, given `settings`), an OAuth provider's API hosts. Null
 * for a provider a remote MCP app can't use: an AI provider, a service,
 * or an OAuth client the Gateway runs no flow for.
 */
export function remoteMcpProviderHosts(
  capability: Capability,
  settings?: CapabilitySettings,
): string[] | null {
  if (capability.mode === "api_key") return apiKeyHosts(capability, settings);
  if (capability.mode === "oauth_client" && capability.flow) {
    return [...capability.api];
  }
  return null;
}

/** Whether `id` can be a remote MCP app's id (kebab-case, at most 32, not reserved, not a built-in's). */
export function remoteMcpIdProblem(id: string): string | null {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return "the id must be kebab-case: lowercase letters, digits and hyphens, starting with a letter";
  }
  if (id.length > ID_MAX_LENGTH) {
    return `the id must be at most ${ID_MAX_LENGTH} characters`;
  }
  if (RESERVED_IDS.includes(id)) return `"${id}" is reserved`;
  if (isProviderAppId(id)) {
    return `"${id}" is the Gateway's built-in MCP app; a remote server can't take its id`;
  }
  return null;
}

/**
 * An app id from the server's URL: the host's registrable name, `www`,
 * `mcp` and `api` dropped (`https://mcp.deepwiki.com/mcp` → `deepwiki`,
 * `https://treg.to/mcp/` → `treg`); null when nothing usable is left (an
 * IP, `localhost`), in which case the caller asks for `--name`.
 */
export function remoteMcpIdFromUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  const labels = host.split(".").filter((label) => label.length > 0);
  if (labels.length < 2) return null;
  // The label before the public suffix, roughly: the last label that
  // isn't a known two-level suffix part (co.uk, com.au).
  const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
  let index = labels.length - 2;
  if (
    index > 0 &&
    SECOND_LEVEL.has(labels[index]!) &&
    labels[index + 1]!.length === 2
  ) {
    index -= 1;
  }
  const candidate = labels[index] ?? "";
  const id = candidate
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, ID_MAX_LENGTH)
    .replace(/-+$/g, "");
  if (!id || !ID_PATTERN.test(id)) return null;
  return remoteMcpIdProblem(id) ? null : id;
}

export interface RemoteMcpUrlEnv {
  /** The Gateway's own URL (`GATEWAY_URL`): its origin is refused, and `http://` opens local dev. */
  gatewayUrl: string;
  /** The apps' domain (`APP_BASE_DOMAIN`): every host under it is refused. */
  appBaseDomain?: string | null;
  /** The hosted third-party apps' domain (`THIRD_PARTY_DOMAIN`): likewise. */
  thirdPartyDomain?: string | null;
}

function isSameOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The hosts whose keys the Gateway holds: a remote server is never one of them. */
export function reservedUpstreamHosts(): string[] {
  const hosts = new Set<string>([
    "api.openai.com",
    "openrouter.ai",
    "gateway.ai.cloudflare.com",
    "api.cloudflare.com",
  ]);
  for (const capability of Object.values(CAPABILITIES)) {
    if (capability.mode === "api_key") {
      for (const host of capability.hosts) hosts.add(host);
    } else if (capability.mode === "oauth_client") {
      hosts.add(new URL(capability.flow.tokenUrl).hostname);
    }
  }
  return [...hosts].sort();
}

/**
 * Why `url` can't be a remote MCP server's address, or null when it can:
 * `https:` (or `http:` and loopback hosts only while the Gateway itself
 * runs on `http://`, local dev), a host name rather than an address, no
 * credentials or fragment in it, not the Gateway's own origin or one of
 * its app hosts, and not a provider whose key the Gateway holds
 * ({@link reservedUpstreamHosts}) unless the app names that provider:
 * `providerHosts` are the hosts of the provider the app's credential is
 * (never an app's own synthesized row), and a reserved host among them is
 * allowed (`mcp add https://api.elevenlabs.io/v1/mcp --provider
 * elevenlabs`). The Gateway's own origin, its app domains and IPs stay
 * refused always. The Gateway checks the stored URL again before every
 * fetch, so a row edited by hand is refused the same way.
 */
export function remoteMcpUrlProblem(
  url: string,
  env: RemoteMcpUrlEnv,
  options: { providerHosts?: readonly string[] } = {},
): string | null {
  if (typeof url !== "string" || !url.trim()) return "give the server's URL";
  if (url.length > URL_MAX_LENGTH) return "the URL is too long";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the URL doesn't parse";
  }
  const local = env.gatewayUrl.trim().toLowerCase().startsWith("http://");
  if (parsed.username || parsed.password) {
    return "the URL must not carry credentials; the Gateway sends the credential from its own setting";
  }
  if (parsed.hash) return "the URL must not have a fragment";
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1";
  if (parsed.protocol !== "https:") {
    if (parsed.protocol === "http:" && local && loopback) {
      // Local dev: a fake or local server on this machine.
    } else {
      return local
        ? "the URL must be https://, or http:// on localhost while the Gateway runs locally"
        : "the URL must be https://";
    }
  }
  if (!host) return "the URL has no host";
  if (!loopback && (/^[\d.]+$/.test(host) || host.startsWith("["))) {
    return "the URL must name a host, not an IP address";
  }
  if (loopback && !local) {
    return "the URL must name a public host";
  }
  // The Gateway's own host: any port and every subdomain of it in
  // production (a Worker on the same zone would be the gateway or an app);
  // in local dev the exact origin only, so a fake server on another
  // localhost port is fine.
  let gatewayHost = "";
  let gatewayOrigin = "";
  try {
    const gateway = new URL(env.gatewayUrl);
    gatewayHost = gateway.hostname.toLowerCase().replace(/\.$/, "");
    gatewayOrigin = gateway.origin.toLowerCase();
  } catch {
    gatewayHost = "";
  }
  if (gatewayHost) {
    const ownHost = local
      ? parsed.origin.toLowerCase() === gatewayOrigin
      : isSameOrSubdomain(host, gatewayHost);
    if (ownHost) return "the URL is this Gateway's own address";
  }
  for (const domain of [env.appBaseDomain, env.thirdPartyDomain]) {
    const normalized = (domain ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (normalized && isSameOrSubdomain(host, normalized)) {
      return `the URL is on this Gateway's app domain (${normalized})`;
    }
  }
  const named = (options.providerHosts ?? []).map((each) =>
    each.toLowerCase().replace(/\.$/, ""),
  );
  if (reservedUpstreamHosts().includes(host) && !named.includes(host)) {
    return `${host} is a provider this Gateway holds a key for; add it with --provider <that provider> so the app uses its key, or reach it through the Gateway's capabilities`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The auth block's problem, or the block as typed: `{ kind: "none" }`,
 * or `{ kind: "provider", provider }` naming a provider id. A
 * block of the kinds before provider credentials (`bearer`, `header`,
 * `basic`, `oauth`) is refused with {@link REMOTE_MCP_AUTH_PREDATES}: such
 * a row serves nothing and reads as needing setup.
 */
export function parseRemoteMcpAuth(
  raw: unknown,
): { ok: true; auth: RemoteMcpAuth } | { ok: false; problem: string } {
  if (!isRecord(raw) || typeof raw["kind"] !== "string") {
    return { ok: false, problem: "auth must name a kind" };
  }
  const kind = raw["kind"];
  if (["bearer", "header", "basic", "oauth"].includes(kind)) {
    return { ok: false, problem: REMOTE_MCP_AUTH_PREDATES };
  }
  if (kind === "none") {
    for (const field of Object.keys(raw)) {
      if (field !== "kind") {
        return {
          ok: false,
          problem: `auth.${field} is not a field of kind none`,
        };
      }
    }
    return { ok: true, auth: { kind } };
  }
  if (kind !== "provider") {
    return {
      ok: false,
      problem: `auth.kind must be one of ${REMOTE_MCP_AUTH_KINDS.join(", ")}`,
    };
  }
  for (const field of Object.keys(raw)) {
    if (!["kind", "provider"].includes(field)) {
      return {
        ok: false,
        problem: `auth.${field} is not a field of kind provider`,
      };
    }
  }
  const provider = raw["provider"];
  if (typeof provider !== "string" || !PROVIDER_ID.test(provider)) {
    return {
      ok: false,
      problem:
        "auth.provider must be a provider id: lowercase letters, digits and hyphens, a letter first",
    };
  }
  return { ok: true, auth: { kind: "provider", provider } };
}

/** The provider the block names, or null for `none`. */
export function remoteMcpProviderOf(auth: RemoteMcpAuth): string | null {
  return auth.kind === "provider" ? auth.provider : null;
}

/**
 * The `remote` block of a stored manifest, checked field by field (a row
 * edited by hand must not make the Gateway send a credential anywhere the
 * rules refuse), or why it can't be read. The URL is checked against the
 * Gateway's environment by the caller ({@link remoteMcpUrlProblem}).
 */
export function parseRemoteMcpBlock(
  raw: unknown,
): { ok: true; block: RemoteMcpBlock } | { ok: false; problem: string } {
  if (!isRecord(raw)) return { ok: false, problem: "remote must be an object" };
  const url = raw["url"];
  if (typeof url !== "string" || !url || url.length > URL_MAX_LENGTH) {
    return { ok: false, problem: "remote.url must be a URL" };
  }
  const auth = parseRemoteMcpAuth(raw["auth"]);
  if (!auth.ok) return auth;
  const risk = raw["risk"] ?? "annotations";
  if (
    !(REMOTE_MCP_RISK_DEFAULTS as readonly string[]).includes(risk as string)
  ) {
    return {
      ok: false,
      problem: `remote.risk must be one of ${REMOTE_MCP_RISK_DEFAULTS.join(", ")}`,
    };
  }
  const tools: Record<string, RemoteMcpToolOverride> = {};
  const rawTools = raw["tools"] ?? {};
  if (!isRecord(rawTools))
    return { ok: false, problem: "remote.tools must be an object" };
  const entries = Object.entries(rawTools);
  if (entries.length > OVERRIDES_MAX) {
    return {
      ok: false,
      problem: `remote.tools has more than ${OVERRIDES_MAX} entries`,
    };
  }
  for (const [name, override] of entries) {
    if (!name || name.length > UPSTREAM_NAME_MAX) {
      return {
        ok: false,
        problem: "remote.tools has a tool name that is empty or too long",
      };
    }
    if (!isRecord(override)) {
      return { ok: false, problem: `remote.tools.${name} must be an object` };
    }
    const out: RemoteMcpToolOverride = {};
    if (override["risk"] !== undefined) {
      if (!isToolRisk(override["risk"])) {
        return {
          ok: false,
          problem: `remote.tools.${name}.risk must be read or write`,
        };
      }
      out.risk = override["risk"];
    }
    if (override["enabled"] !== undefined) {
      if (typeof override["enabled"] !== "boolean") {
        return {
          ok: false,
          problem: `remote.tools.${name}.enabled must be true or false`,
        };
      }
      out.enabled = override["enabled"];
    }
    tools[name] = out;
  }
  const rev = raw["rev"] ?? 1;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) {
    return { ok: false, problem: "remote.rev must be a positive integer" };
  }
  return {
    ok: true,
    block: {
      url,
      auth: auth.auth,
      risk: risk as RemoteMcpRiskDefault,
      tools,
      rev,
    },
  };
}

/**
 * The `remote` block of a stored manifest, or null when the manifest has
 * none (a built-in provider app's, a deployed app's) or it can't be read
 * (such a row is a provider row the Gateway serves nothing for and lists
 * as needing setup, see app-setup).
 */
export function remoteMcpOf(manifest: unknown): RemoteMcpBlock | null {
  if (!isRecord(manifest) || manifest["remote"] === undefined) return null;
  const parsed = parseRemoteMcpBlock(manifest["remote"]);
  return parsed.ok ? parsed.block : null;
}

/**
 * Why a stored manifest's `remote` block can't be read, or null when it
 * can or there is none: {@link REMOTE_MCP_AUTH_PREDATES} for a block from
 * before provider credentials.
 */
export function remoteMcpBlockProblem(manifest: unknown): string | null {
  if (!isRecord(manifest) || manifest["remote"] === undefined) return null;
  const parsed = parseRemoteMcpBlock(manifest["remote"]);
  return parsed.ok ? null : parsed.problem;
}

/** Whether a stored manifest declares a remote MCP server at all (well-formed or not). */
export function hasRemoteMcpBlock(manifest: unknown): boolean {
  return isRecord(manifest) && manifest["remote"] !== undefined;
}

/**
 * A description for a row that gave none: the server's origin, read as a
 * sentence. The origin only: a path or query may carry something the
 * registrar meant for the server alone, and the description reaches every
 * member with access and every AI client.
 */
export function remoteMcpDefaultDescription(name: string, url: string): string {
  let where = "";
  try {
    where = new URL(url).origin;
  } catch {
    where = "";
  }
  return `${name}'s MCP server${where ? ` at ${where}` : ""}, served to your AI clients through this Gateway.`;
}

/**
 * The operator's override for a server tool: by the server's name, or by
 * a name that becomes the same ToolBus name ({@link normalizeRemoteToolName}),
 * so a server that renames `send-mail` to `send_mail` can't bring a tool the
 * operator turned off back under the same listed name.
 */
export function remoteToolOverride(
  block: Pick<RemoteMcpBlock, "tools">,
  upstreamName: string,
): RemoteMcpToolOverride | undefined {
  const exact = block.tools[upstreamName];
  if (exact) return exact;
  const local = normalizeRemoteToolName(upstreamName);
  if (!local) return undefined;
  for (const [key, override] of Object.entries(block.tools)) {
    if (normalizeRemoteToolName(key) === local) return override;
  }
  return undefined;
}

/** Whether a server's tool name can travel in an HTTP header (`Mcp-Name`): visible ASCII, bounded. */
export function isHeaderSafeToolName(name: string): boolean {
  return /^[\x21-\x7e]{1,256}$/.test(name);
}

/**
 * The entry a remote MCP app's manifest lists its provider under
 * (`capabilities`), as a deployed app lists one: `{ access, why }` for an
 * API-key provider, `{ scopes, why }` for an OAuth one.
 */
export type RemoteMcpCapabilityEntry =
  | { access: "read"; why: string }
  | { scopes: string[]; why: string };

/**
 * The manifest a remote MCP app's row stores, from what the registrar
 * gave. An app with a provider credential lists the provider under
 * `capabilities` like a deployed app that uses it, so the settings model
 * (./appSettings.ts) asks for its key or client, `secret list` names it
 * and the connect flow asks for its scopes: nothing about a remote app's
 * credential is special there. `providerCapability` is the provider as
 * the registry resolves it (the synthesized row's, before it is written);
 * for an OAuth provider the entry lists `scopes`, the server's own scope
 * strings the connect asks for (discovery's, or none: the server decides).
 */
export function remoteMcpAppManifest(input: {
  id: string;
  name?: string | null;
  description?: string | null;
  remote: RemoteMcpBlock;
  providerCapability?: Capability | null;
  /** An OAuth provider's scopes the connect asks for. */
  scopes?: readonly string[] | null;
}): RemoteMcpManifest {
  const name = (input.name ?? "").trim().slice(0, NAME_MAX_LENGTH) || input.id;
  const description =
    (input.description ?? "").trim().slice(0, DESCRIPTION_MAX_LENGTH) ||
    remoteMcpDefaultDescription(name, input.remote.url);
  const manifest: RemoteMcpManifest = {
    id: input.id,
    name,
    description,
    remote: input.remote,
  };
  const auth = input.remote.auth;
  if (auth.kind !== "provider") return manifest;
  let where = "";
  try {
    where = new URL(input.remote.url).origin;
  } catch {
    where = "the server";
  }
  const why = `${name}'s MCP server at ${where} takes this credential; the Gateway sends it there when a member calls the app's tools.`;
  const shortWhy = why.length > 200 ? `${why.slice(0, 199)}…` : why;
  manifest.capabilities = {
    [auth.provider]:
      input.providerCapability?.mode === "oauth_client"
        ? { scopes: [...(input.scopes ?? [])], why: shortWhy }
        : { access: "read", why: shortWhy },
  };
  return manifest;
}

/** How a tool got its risk: the server's hint, the app's default, the operator's override, or the fallback. */
export type RemoteToolRiskSource = "hint" | "app" | "override" | "default";

/**
 * A tool's risk for the Gateway. An override wins; then the app's `read`
 * or `write` default; then the server's hints: an explicit `readOnlyHint:
 * true` is `read`, and anything else, a missing hint included, is `write`.
 * A write tool keeps the server's `destructiveHint`, so clients still ask
 * before calling it.
 */
export function remoteToolRisk(
  hints: { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined,
  block: Pick<RemoteMcpBlock, "risk" | "tools">,
  upstreamName: string,
): { risk: ToolRisk; source: RemoteToolRiskSource } {
  const override = remoteToolOverride(block, upstreamName)?.risk;
  if (override) return { risk: override, source: "override" };
  if (block.risk === "read" || block.risk === "write") {
    return { risk: block.risk, source: "app" };
  }
  if (hints?.readOnlyHint === true) return { risk: "read", source: "hint" };
  if (hints?.destructiveHint === true) return { risk: "write", source: "hint" };
  return { risk: "write", source: "default" };
}

/** Whether the operator left the tool on (the default). */
export function remoteToolEnabled(
  block: Pick<RemoteMcpBlock, "tools">,
  upstreamName: string,
): boolean {
  return remoteToolOverride(block, upstreamName)?.enabled !== false;
}

/**
 * A server's tool name as the ToolBus lists it: lowercase snake_case, at
 * most 48 characters (`TOOL_NAME_PATTERN`). camelCase is split
 * (`getUser` → `get_user`), `-`, `.`, `/` and spaces become `_`, anything
 * else is dropped, runs of `_` collapse, and a leading digit gets a `t_`
 * in front. Null when nothing usable is left.
 */
export function normalizeRemoteToolName(name: string): string | null {
  if (typeof name !== "string") return null;
  let out = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s./:-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!out) return null;
  if (/^[0-9]/.test(out)) out = `t_${out}`;
  out = out.slice(0, 48).replace(/_+$/g, "");
  return TOOL_NAME_PATTERN.test(out) ? out : null;
}

/**
 * Plain words for how the app authenticates, for lists and dialogs. With
 * the provider's capability as the registry resolves it: "bearer token",
 * "header X-Api-Key", "query parameter key", "user and password" (an
 * API-key provider; "<kind>, <provider>'s key" when the provider isn't
 * the app's own synthesized row), or "OAuth, each member connects" (an
 * OAuth provider). Without it, the provider's id.
 */
export function remoteMcpAuthLabel(
  auth: RemoteMcpAuth,
  capability?: Capability | null,
): string {
  if (auth.kind === "none") return "no credential";
  if (!capability) return `provider ${auth.provider}`;
  if (capability.mode === "oauth_client") {
    return "OAuth, each member connects";
  }
  if (capability.mode !== "api_key") return `provider ${auth.provider}`;
  const placement = capability.auth;
  const words =
    placement.kind === "bearer"
      ? placement.scheme && placement.scheme.toLowerCase() !== "bearer"
        ? `${placement.scheme} token`
        : "bearer token"
      : placement.kind === "header"
        ? `header ${placement.header}`
        : placement.kind === "query"
          ? `query parameter ${placement.param}`
          : placement.as === "pair"
            ? "user and password"
            : "basic auth";
  return auth.provider.endsWith("-mcp")
    ? words
    : `${words}, ${capability.label}'s key`;
}
