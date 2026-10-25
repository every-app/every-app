/**
 * Remote MCP apps: any remote MCP server registered on a gateway by URL
 * (`everyapp mcp add <url>`, Admin → Apps → Add app → "Add an MCP server",
 * `everyapp_mcp_add`), served to members' AI clients as an MCP app of the
 * Gateway's own, like a built-in provider app (./providerApps.ts) but with
 * its tools read from the server and each call forwarded to it with a
 * credential the Gateway holds (docs/design/2026-10-mcp-by-url.md).
 *
 * The registration record is the app row's manifest: `id`, `name`,
 * `description` and a `remote` block ({@link RemoteMcpBlock}): the one URL
 * the Gateway ever fetches, how it authenticates ({@link RemoteMcpAuth},
 * the credential always the NAME of a Gateway setting, never a value), how
 * a tool's risk is decided when the server's annotations don't say, the
 * operator's per-tool overrides, and a revision the writers bump so the
 * Gateway re-lists the tools on first use after a change.
 *
 * Everything here is pure and shared by the CLI, the perimeter's registry
 * rules, the Gateway (which serves the row and validates again at every
 * fetch) and the settings model (./appSettings.ts), so the rules cannot
 * drift: what the URL may be, what the credential may be called, how a
 * server's tool names become the ToolBus's, and what risk a tool gets.
 */
import { CAPABILITIES } from "./capabilities.js";
import { isRemoteMcpSecretName } from "./gatewaySettings.js";
import { isProviderAppId } from "./providerApps.js";
import { TOOL_NAME_PATTERN, isToolRisk, type ToolRisk } from "./tools.js";

export const REMOTE_MCP_AUTH_KINDS = [
  "none",
  "bearer",
  "header",
  "basic",
  "oauth",
] as const;
export type RemoteMcpAuthKind = (typeof REMOTE_MCP_AUTH_KINDS)[number];

/**
 * How the Gateway authenticates to the server. `secret` is the name of
 * the Gateway setting holding the value ({@link remoteMcpSecretName}),
 * never the value. `oauth` is recorded so the app can say what the server
 * wants; it is not served (the design's section 10).
 */
export type RemoteMcpAuth =
  | { kind: "none" }
  /** `Authorization: Bearer <value>`. */
  | { kind: "bearer"; secret: string }
  /** `<header>: <prefix><value>`. */
  | { kind: "header"; secret: string; header: string; prefix?: string }
  /** The value is `user:password`; sent as `Authorization: Basic <base64>`. */
  | { kind: "basic"; secret: string }
  | { kind: "oauth" };

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
}

/** The manifest fields the Gateway reads, as a stored manifest has them. */
export interface RemoteMcpManifestLike {
  readonly remote?: unknown;
}

const ID_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const ID_MAX_LENGTH = 32;
/** App ids a remote server can't take: the Gateway's own tool prefix. */
const RESERVED_IDS: readonly string[] = ["everyapp"];
const SECRET_MAX_LENGTH = 64;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const PREFIX_MAX_LENGTH = 32;
const URL_MAX_LENGTH = 2048;
const NAME_MAX_LENGTH = 255;
const DESCRIPTION_MAX_LENGTH = 1000;
const OVERRIDES_MAX = 500;
const UPSTREAM_NAME_MAX = 256;

/**
 * Headers the `header` kind may not name: the ones the Gateway sets on the
 * request, the ones that route it, and the ones that would carry something
 * other than this app's credential.
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
]);

/** The default credential name for an app id: `treg` → `TREG_MCP_TOKEN`. */
export function remoteMcpSecretName(id: string): string {
  return `${id.toUpperCase().replace(/-/g, "_")}_MCP_TOKEN`;
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
      for (const endpoint of capability.token) {
        if ("host" in endpoint && typeof endpoint.host === "string") {
          hosts.add(endpoint.host);
        }
      }
    }
  }
  return [...hosts].sort();
}

/**
 * Why `url` can't be a remote MCP server's address, or null when it can:
 * `https:` (or `http:` and loopback hosts only while the Gateway itself
 * runs on `http://`, local dev), a host name rather than an address, no
 * credentials or fragment in it, not the Gateway's own origin or one of
 * its app hosts, and not a provider whose key the Gateway holds. The
 * Gateway checks the stored URL again before every fetch, so a row edited
 * by hand is refused the same way.
 */
export function remoteMcpUrlProblem(
  url: string,
  env: RemoteMcpUrlEnv,
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
  let gatewayOrigin = "";
  try {
    gatewayOrigin = new URL(env.gatewayUrl).origin.toLowerCase();
  } catch {
    gatewayOrigin = "";
  }
  if (gatewayOrigin && parsed.origin.toLowerCase() === gatewayOrigin) {
    return "the URL is this Gateway's own address";
  }
  for (const domain of [env.appBaseDomain, env.thirdPartyDomain]) {
    const normalized = (domain ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (normalized && isSameOrSubdomain(host, normalized)) {
      return `the URL is on this Gateway's app domain (${normalized})`;
    }
  }
  if (reservedUpstreamHosts().includes(host)) {
    return `${host} is a provider this Gateway holds a key for; apps reach it through the Gateway's capabilities, not as an MCP app`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The credential name's problem, or null: in the family, and bounded. */
export function remoteMcpSecretProblem(name: unknown): string | null {
  if (typeof name !== "string" || !name)
    return "give the credential's setting name";
  if (name.length > SECRET_MAX_LENGTH)
    return "the credential's name is too long";
  if (!isRemoteMcpSecretName(name)) {
    return `the credential's name must end in _MCP_TOKEN (letters, digits and underscores), like ${remoteMcpSecretName("treg")}`;
  }
  return null;
}

/** The auth block's problem, or the block as typed. */
export function parseRemoteMcpAuth(
  raw: unknown,
): { ok: true; auth: RemoteMcpAuth } | { ok: false; problem: string } {
  if (!isRecord(raw) || typeof raw["kind"] !== "string") {
    return { ok: false, problem: "auth must name a kind" };
  }
  const kind = raw["kind"];
  if (!(REMOTE_MCP_AUTH_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      problem: `auth.kind must be one of ${REMOTE_MCP_AUTH_KINDS.join(", ")}`,
    };
  }
  if (kind === "none" || kind === "oauth") {
    return { ok: true, auth: { kind } };
  }
  const secretProblem = remoteMcpSecretProblem(raw["secret"]);
  if (secretProblem)
    return { ok: false, problem: `auth.secret: ${secretProblem}` };
  const secret = raw["secret"] as string;
  if (kind === "bearer" || kind === "basic") {
    return { ok: true, auth: { kind, secret } };
  }
  const header = raw["header"];
  if (typeof header !== "string" || !HEADER_NAME_PATTERN.test(header)) {
    return { ok: false, problem: "auth.header must be an HTTP header name" };
  }
  if (FORBIDDEN_AUTH_HEADERS.has(header.toLowerCase())) {
    return {
      ok: false,
      problem: `auth.header can't be ${header}; use kind "bearer" or "basic" for Authorization`,
    };
  }
  const prefix = raw["prefix"];
  if (prefix !== undefined) {
    if (
      typeof prefix !== "string" ||
      prefix.length > PREFIX_MAX_LENGTH ||
      /[\r\n]/.test(prefix)
    ) {
      return { ok: false, problem: "auth.prefix must be a short string" };
    }
  }
  return {
    ok: true,
    auth: {
      kind: "header",
      secret,
      header,
      ...(typeof prefix === "string" && prefix ? { prefix } : {}),
    },
  };
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
          problem: `remote.tools.${name}.risk must be read, write or destructive`,
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

/** Whether a stored manifest declares a remote MCP server at all (well-formed or not). */
export function hasRemoteMcpBlock(manifest: unknown): boolean {
  return isRecord(manifest) && manifest["remote"] !== undefined;
}

/** The credential's setting name the block declares, if its kind takes one. */
export function remoteMcpSecretOf(auth: RemoteMcpAuth): string | null {
  return "secret" in auth ? auth.secret : null;
}

/** A description for a row that gave none: the server's URL, read as a sentence. */
export function remoteMcpDefaultDescription(name: string, url: string): string {
  return `${name}'s MCP server (${url}), served to your AI clients through this Gateway.`;
}

/** The manifest a remote MCP app's row stores, from what the registrar gave. */
export function remoteMcpAppManifest(input: {
  id: string;
  name?: string | null;
  description?: string | null;
  remote: RemoteMcpBlock;
}): RemoteMcpManifest {
  const name = (input.name ?? "").trim().slice(0, NAME_MAX_LENGTH) || input.id;
  const description =
    (input.description ?? "").trim().slice(0, DESCRIPTION_MAX_LENGTH) ||
    remoteMcpDefaultDescription(name, input.remote.url);
  return { id: input.id, name, description, remote: input.remote };
}

/** How a tool got its risk: the server's hint, the app's default, the operator's override, or the fallback. */
export type RemoteToolRiskSource = "hint" | "app" | "override" | "default";

/**
 * A tool's risk for the Gateway. An override wins; then the app's `read`
 * or `write` default; then the server's hints, read conservatively: an
 * explicit `readOnlyHint: true` is `read`, an explicit `destructiveHint:
 * true` is `destructive` (hidden until approvals exist), and anything
 * else, a missing hint included, is `write`. The spec's missing-means-true
 * default for `destructiveHint` is not followed: it would hide every
 * unhinted tool.
 */
export function remoteToolRisk(
  hints: { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined,
  block: Pick<RemoteMcpBlock, "risk" | "tools">,
  upstreamName: string,
): { risk: ToolRisk; source: RemoteToolRiskSource } {
  const override = block.tools[upstreamName]?.risk;
  if (override) return { risk: override, source: "override" };
  if (block.risk === "read" || block.risk === "write") {
    return { risk: block.risk, source: "app" };
  }
  if (hints?.readOnlyHint === true) return { risk: "read", source: "hint" };
  if (hints?.destructiveHint === true) {
    return { risk: "destructive", source: "hint" };
  }
  return { risk: "write", source: "default" };
}

/** Whether the operator left the tool on (the default). */
export function remoteToolEnabled(
  block: Pick<RemoteMcpBlock, "tools">,
  upstreamName: string,
): boolean {
  return block.tools[upstreamName]?.enabled !== false;
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
 * The request headers that carry the credential for `auth`, from the
 * setting's value. The value never appears anywhere else.
 */
export function remoteMcpAuthHeaders(
  auth: RemoteMcpAuth,
  value: string,
): Record<string, string> {
  switch (auth.kind) {
    case "none":
    case "oauth":
      return {};
    case "bearer":
      return { authorization: `Bearer ${value}` };
    case "basic":
      return { authorization: `Basic ${base64(value)}` };
    case "header":
      return { [auth.header]: `${auth.prefix ?? ""}${value}` };
  }
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Plain words for an auth kind, for lists and dialogs. */
export function remoteMcpAuthLabel(auth: RemoteMcpAuth): string {
  switch (auth.kind) {
    case "none":
      return "no credential";
    case "bearer":
      return "bearer token";
    case "basic":
      return "user and password";
    case "header":
      return `header ${auth.header}`;
    case "oauth":
      return "OAuth (not supported yet)";
  }
}
