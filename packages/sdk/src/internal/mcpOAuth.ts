/**
 * OAuth to remote MCP servers (docs/design/2026-11-mcp-apps-auth.md, the
 * MCP authorization spec): discovering a server's authorization server,
 * registering a client with it, and the provider specs `everyapp mcp add`
 * and the Gateway's "Add an MCP server" write for an app's own credential
 * (`<appId>-mcp`, ./remoteMcp.ts). Pure apart from the injected `fetch`:
 * the CLI runs it from the operator's machine, the Gateway in-process.
 *
 * Every fetch here is bounded the same way: https only, a public host
 * (`publicHostProblem`, and no IP literal), the default port, no redirects
 * followed (`redirect: "manual"`; a 3xx is a failure), at most
 * {@link MCP_OAUTH_MAX_BODY} bytes of answer and {@link MCP_OAUTH_TIMEOUT_MS}
 * per request. Nothing fetched here ever carries a credential except the
 * registration request, which carries none either (RFC 7591's open
 * registration).
 *
 * Discovery (RFC 9728, then RFC 8414 / OpenID discovery):
 *  1. the protected resource metadata: `resourceMetadataUrl` (the 401's
 *     `resource_metadata`) when given, else
 *     `<origin>/.well-known/oauth-protected-resource<path>`, then
 *     `<origin>/.well-known/oauth-protected-resource`. Its `resource` must
 *     be the MCP URL or a path prefix of it on the same origin;
 *     `authorization_servers[0]` is the issuer.
 *  2. the issuer's metadata: `/.well-known/oauth-authorization-server`
 *     path-inserted, then `/.well-known/openid-configuration` path-inserted
 *     and path-appended. `issuer` must be the one asked for; PKCE S256
 *     must be supported.
 *  3. a server without resource metadata (the 2025-03-26 spec): the
 *     authorization server metadata at the MCP URL's origin.
 */
import type { OAuthClientInjection } from "./capabilities.js";
import { publicHostProblem } from "./providerRegistry.js";
import { parseProviderSpec, describeSpecProblems } from "./providerSpec.js";
import {
  remoteMcpClientIdSetting,
  remoteMcpClientSecretSetting,
  remoteMcpHeaderProblem,
  remoteMcpProviderId,
  remoteMcpTokenSetting,
  type RemoteMcpStaticKind,
} from "./remoteMcp.js";

/** The largest answer a discovery or registration fetch reads: 64 KiB. */
export const MCP_OAUTH_MAX_BODY = 64 * 1024;
/** How long one discovery or registration fetch may take. */
export const MCP_OAUTH_TIMEOUT_MS = 10_000;

/** The fetch this module is given (the global one, or a test's). */
export type McpOAuthFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** What a `WWW-Authenticate: Bearer …` challenge says (RFC 6750, RFC 9728 section 5.1). */
export interface McpBearerChallenge {
  /** `resource_metadata`: where the protected resource metadata is. */
  resourceMetadata?: string;
  /** `scope`: the scopes the server wants for the request, space-separated. */
  scope?: string;
  /** `error`: `invalid_token`, `insufficient_scope`, … */
  error?: string;
}

const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

/**
 * The Bearer challenge of a `WWW-Authenticate` header, or null when the
 * header carries none. Reads several challenges in one header
 * (`Basic realm="x", Bearer resource_metadata="…"`), quoted and bare
 * values, and parameter names in any case.
 */
export function parseWwwAuthenticate(
  header: string | null | undefined,
): McpBearerChallenge | null {
  if (typeof header !== "string" || !header.trim()) return null;
  const challenges: Array<{ scheme: string; params: Record<string, string> }> =
    [];
  let current: { scheme: string; params: Record<string, string> } | null = null;
  let i = 0;
  const n = header.length;
  const skip = (chars: RegExp) => {
    while (i < n && chars.test(header[i]!)) i++;
  };
  const token = (): string => {
    const start = i;
    while (i < n && TOKEN_CHAR.test(header[i]!)) i++;
    return header.slice(start, i);
  };
  while (i < n) {
    skip(/[\s,]/);
    if (i >= n) break;
    const name = token();
    if (!name) {
      // Something unreadable: skip to the next comma.
      while (i < n && header[i] !== ",") i++;
      continue;
    }
    const afterName = i;
    skip(/[ \t]/);
    if (header[i] === "=" && header[i + 1] !== "=") {
      i++;
      skip(/[ \t]/);
      let value = "";
      if (header[i] === '"') {
        i++;
        while (i < n && header[i] !== '"') {
          if (header[i] === "\\" && i + 1 < n) i++;
          value += header[i];
          i++;
        }
        i++;
      } else {
        const start = i;
        while (i < n && header[i] !== "," && !/\s/.test(header[i]!)) i++;
        value = header.slice(start, i);
      }
      if (current) current.params[name.toLowerCase()] = value;
      continue;
    }
    // A scheme: a new challenge. (A token68 after another scheme reads
    // as a scheme of its own; only the Bearer challenge is looked at.)
    i = afterName;
    current = { scheme: name.toLowerCase(), params: {} };
    challenges.push(current);
  }
  const bearer = challenges.find((challenge) => challenge.scheme === "bearer");
  if (!bearer) return null;
  const out: McpBearerChallenge = {};
  if (bearer.params["resource_metadata"]) {
    out.resourceMetadata = bearer.params["resource_metadata"];
  }
  if (bearer.params["scope"]) out.scope = bearer.params["scope"];
  if (bearer.params["error"]) out.error = bearer.params["error"];
  return out;
}

/** What discovery found: everything the synthesized OAuth row needs. */
export interface McpOAuthDiscovery {
  /** The protected resource (RFC 8707 `resource`): the metadata's `resource`, or the MCP URL for a server without metadata. */
  resource: string;
  /** The authorization server's issuer, as its metadata spells it (what `iss` must equal). */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  /** The scopes to ask for: the challenge's `scope`, else the resource's `scopes_supported`, else none. */
  scopes: string[];
  /** The resource's `scopes_supported`, every one a token may carry. */
  supportedScopes?: string[];
  /** `token_endpoint_auth_methods_supported`, `["client_secret_basic"]` when the server says nothing (RFC 8414's default). */
  tokenEndpointAuthMethods: string[];
  /** Whether the server had protected resource metadata (false: the 2025-03-26 fallback). */
  resourceMetadata: boolean;
}

export type McpOAuthDiscoveryResult =
  | { ok: true; discovery: McpOAuthDiscovery }
  | { ok: false; problem: string };

/** Why `url` can't be fetched by discovery, or null when it can. */
export function mcpOAuthUrlProblem(
  url: string,
  { query = true }: { query?: boolean } = {},
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} isn't a URL`;
  }
  if (parsed.protocol !== "https:") return `${url} isn't https`;
  if (parsed.username || parsed.password) {
    return `${url} carries credentials`;
  }
  if (parsed.hash || url.includes("#")) return `${url} has a fragment`;
  if (parsed.port) {
    return `${url} is on port ${parsed.port}; the Gateway's OAuth requests go to port 443 only`;
  }
  if (!query && parsed.search) return `${url} carries a query string`;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || host.includes(":")) {
    return `${host} is an IP address, not a host name`;
  }
  const problem = publicHostProblem(host);
  if (problem) return problem;
  if (!host.includes(".")) return `${host} is not a public host`;
  return null;
}

type Fetched =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "missing"; status: number }
  | { kind: "failed"; problem: string };

async function readBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MCP_OAUTH_MAX_BODY) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MCP_OAUTH_MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * One bounded fetch: a JSON object, `missing` for a 4xx or 5xx (the next
 * candidate is tried), `failed` for anything that ends discovery (a
 * redirect, an oversize or unreadable answer, a network error, a refused
 * URL).
 */
async function fetchJson(
  fetcher: McpOAuthFetch,
  url: string,
  init: RequestInit = {},
): Promise<Fetched> {
  const problem = mcpOAuthUrlProblem(url);
  if (problem) return { kind: "failed", problem };
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(MCP_OAUTH_TIMEOUT_MS),
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    const timeout =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      kind: "failed",
      problem: timeout
        ? `${url} didn't answer within ${MCP_OAUTH_TIMEOUT_MS / 1000} s`
        : `${url} couldn't be fetched (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    return {
      kind: "failed",
      problem: `${url} answered with a redirect (${response.status || "3xx"}); discovery follows none`,
    };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { kind: "missing", status: response.status };
  }
  const text = await readBounded(response);
  if (text === null) {
    return {
      kind: "failed",
      problem: `${url} answered with more than ${MCP_OAUTH_MAX_BODY / 1024} KiB`,
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "failed", problem: `${url} didn't answer with JSON` };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      kind: "failed",
      problem: `${url} didn't answer with a JSON object`,
    };
  }
  return { kind: "json", body: body as Record<string, unknown> };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** `/.well-known/<name>` inserted before `url`'s path (none for a bare origin). */
function pathInserted(url: URL, name: string): string {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/${name}${path}`;
}

/** Whether the metadata's `resource` is `mcpUrl` or a path prefix of it on the same origin. */
function resourceCovers(resource: string, mcpUrl: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    return false;
  }
  if (parsed.origin !== mcpUrl.origin || parsed.hash) return false;
  if (parsed.search && parsed.search !== mcpUrl.search) return false;
  const base = parsed.pathname;
  const path = mcpUrl.pathname;
  if (base === path || base === "/" || base === "") return true;
  const trimmed = base.replace(/\/+$/, "");
  return (
    path === trimmed || path.startsWith(`${trimmed}/`) || path === `${trimmed}/`
  );
}

function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** The issuer's metadata URLs, in the MCP spec's order. */
function metadataUrls(issuer: URL): string[] {
  const path =
    issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/+$/, "");
  if (!path) {
    return [
      `${issuer.origin}/.well-known/oauth-authorization-server`,
      `${issuer.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
}

function scopeList(value: string | readonly string[] | undefined): string[] {
  const raw =
    typeof value === "string" ? value.split(/\s+/) : [...(value ?? [])];
  const out: string[] = [];
  for (const scope of raw) {
    // What a provider spec's scope list takes: printable, no space or comma, bounded.
    if (
      !scope ||
      scope.length > 200 ||
      /[\s,]/.test(scope) ||
      /[\p{Cc}\p{Cf}]/u.test(scope) ||
      out.includes(scope)
    ) {
      continue;
    }
    out.push(scope);
    if (out.length === 40) break;
  }
  return out;
}

async function authorizationServer(
  fetcher: McpOAuthFetch,
  issuer: string,
): Promise<
  | {
      ok: true;
      metadata: Record<string, unknown>;
      issuer: string;
    }
  | { ok: false; problem: string }
> {
  const problem = mcpOAuthUrlProblem(issuer, { query: false });
  if (problem) {
    return { ok: false, problem: `the authorization server: ${problem}` };
  }
  const tried: string[] = [];
  for (const url of metadataUrls(new URL(issuer))) {
    tried.push(url);
    const fetched = await fetchJson(fetcher, url);
    if (fetched.kind === "failed")
      return { ok: false, problem: fetched.problem };
    if (fetched.kind === "missing") continue;
    const said = fetched.body["issuer"];
    if (typeof said !== "string" || !sameIssuer(said, issuer)) {
      return {
        ok: false,
        problem: `${url} names the issuer ${typeof said === "string" ? said : "(none)"}, not ${issuer}; the Gateway refuses metadata for another server`,
      };
    }
    return { ok: true, metadata: fetched.body, issuer: said };
  }
  return {
    ok: false,
    problem: `no authorization server metadata for ${issuer} (tried ${tried.join(", ")})`,
  };
}

function endpointOf(
  metadata: Record<string, unknown>,
  field: string,
  { required, query }: { required: boolean; query: boolean },
): { ok: true; url?: string } | { ok: false; problem: string } {
  const value = metadata[field];
  if (value === undefined || value === null || value === "") {
    return required
      ? {
          ok: false,
          problem: `the authorization server's metadata has no ${field}`,
        }
      : { ok: true };
  }
  if (typeof value !== "string" || value.length > 500) {
    return {
      ok: false,
      problem: `the authorization server's ${field} isn't a URL`,
    };
  }
  const problem = mcpOAuthUrlProblem(value, { query });
  return problem
    ? { ok: false, problem: `the authorization server's ${field}: ${problem}` }
    : { ok: true, url: value };
}

/**
 * Find how `url`'s MCP server takes OAuth: its protected resource, its
 * authorization server, the endpoints, the scopes to ask for and the
 * client authentication it accepts. Refuses (with the reason) anything
 * the Gateway would not run: no PKCE S256, a resource that isn't this
 * server, metadata naming another issuer, an endpoint off https or on a
 * private host, a redirect anywhere.
 */
export async function discoverMcpOAuth(input: {
  url: string;
  fetch: McpOAuthFetch;
  /** The 401's `resource_metadata` ({@link parseWwwAuthenticate}). */
  resourceMetadataUrl?: string | null;
  /** The 401's `scope`, asked for ahead of `scopes_supported`. */
  scope?: string | null;
}): Promise<McpOAuthDiscoveryResult> {
  const urlProblem = mcpOAuthUrlProblem(input.url);
  if (urlProblem) return { ok: false, problem: urlProblem };
  const mcpUrl = new URL(input.url);
  const candidates = input.resourceMetadataUrl
    ? [input.resourceMetadataUrl]
    : [
        ...(mcpUrl.pathname === "/" || mcpUrl.pathname === ""
          ? []
          : [pathInserted(mcpUrl, "oauth-protected-resource")]),
        `${mcpUrl.origin}/.well-known/oauth-protected-resource`,
      ];
  let resourceMetadata: Record<string, unknown> | null = null;
  let resourceMetadataAt = "";
  for (const candidate of candidates) {
    const fetched = await fetchJson(input.fetch, candidate);
    if (fetched.kind === "failed") {
      return { ok: false, problem: fetched.problem };
    }
    if (fetched.kind === "missing") continue;
    resourceMetadata = fetched.body;
    resourceMetadataAt = candidate;
    break;
  }
  if (!resourceMetadata && input.resourceMetadataUrl) {
    return {
      ok: false,
      problem: `the server named its resource metadata at ${input.resourceMetadataUrl}, which didn't answer`,
    };
  }

  let issuer: string;
  let resource: string;
  let supported: string[] = [];
  if (resourceMetadata) {
    const said = resourceMetadata["resource"];
    if (typeof said !== "string" || !resourceCovers(said, mcpUrl)) {
      return {
        ok: false,
        problem: `${resourceMetadataAt} describes ${typeof said === "string" ? said : "no resource"}, not ${input.url}; the Gateway refuses metadata for another server`,
      };
    }
    const servers = stringList(resourceMetadata["authorization_servers"]);
    if (servers.length === 0) {
      return {
        ok: false,
        problem: `${resourceMetadataAt} names no authorization server`,
      };
    }
    issuer = servers[0]!;
    resource = said;
    supported = stringList(resourceMetadata["scopes_supported"]);
  } else {
    // The 2025-03-26 spec: the authorization server is at the MCP origin.
    issuer = mcpUrl.origin;
    resource = input.url;
  }

  const server = await authorizationServer(input.fetch, issuer);
  if (!server.ok) {
    return {
      ok: false,
      problem: resourceMetadata
        ? server.problem
        : `${input.url} has no OAuth metadata: no protected resource metadata, and ${server.problem}`,
    };
  }
  const metadata = server.metadata;
  const methods = stringList(metadata["code_challenge_methods_supported"]);
  if (!methods.includes("S256")) {
    return {
      ok: false,
      problem: `${server.issuer} doesn't support PKCE with S256 (code_challenge_methods_supported), which the Gateway requires`,
    };
  }
  const authorize = endpointOf(metadata, "authorization_endpoint", {
    required: true,
    query: true,
  });
  if (!authorize.ok) return authorize;
  const token = endpointOf(metadata, "token_endpoint", {
    required: true,
    query: false,
  });
  if (!token.ok) return token;
  const registration = endpointOf(metadata, "registration_endpoint", {
    required: false,
    query: false,
  });
  if (!registration.ok) return registration;
  const revocation = endpointOf(metadata, "revocation_endpoint", {
    required: false,
    query: false,
  });
  if (!revocation.ok) return revocation;
  const authMethods = stringList(
    metadata["token_endpoint_auth_methods_supported"],
  );
  const scopes = input.scope ? scopeList(input.scope) : scopeList(supported);
  return {
    ok: true,
    discovery: {
      resource,
      issuer: server.issuer,
      authorizationEndpoint: authorize.url!,
      tokenEndpoint: token.url!,
      ...(registration.url ? { registrationEndpoint: registration.url } : {}),
      ...(revocation.url ? { revocationEndpoint: revocation.url } : {}),
      scopes,
      ...(scopeList(supported).length > 0
        ? { supportedScopes: scopeList(supported) }
        : {}),
      tokenEndpointAuthMethods:
        authMethods.length > 0 ? authMethods : ["client_secret_basic"],
      resourceMetadata: resourceMetadata !== null,
    },
  };
}

export type McpClientRegistration =
  | {
      ok: true;
      clientId: string;
      clientSecret?: string;
      /** Where the client goes on the token request: HTTP Basic, or the form body. */
      inject: OAuthClientInjection;
      /** The method the server registered (`client_secret_basic`, `client_secret_post`, `none`). */
      authMethod: string;
    }
  | {
      ok: false;
      problem: string;
      /** The server offers no registration endpoint: a client must be pasted. */
      unsupported?: boolean;
    };

/** The token endpoint auth method to ask for: Basic when offered, else the form, else a public client. */
export function chooseTokenEndpointAuthMethod(
  supported: readonly string[],
): "client_secret_basic" | "client_secret_post" | "none" | null {
  if (supported.includes("client_secret_basic")) return "client_secret_basic";
  if (supported.includes("client_secret_post")) return "client_secret_post";
  if (supported.includes("none")) return "none";
  return null;
}

/**
 * Register a client with the server's authorization server (RFC 7591
 * dynamic client registration): the Gateway's callback as the one
 * redirect URI, the authorization-code and refresh grants, and the token
 * endpoint auth method {@link chooseTokenEndpointAuthMethod} picks. Reads
 * back what the server registered: its method decides `inject`.
 */
export async function registerMcpClient(input: {
  discovery: McpOAuthDiscovery;
  redirectUri: string;
  clientName: string;
  fetch: McpOAuthFetch;
}): Promise<McpClientRegistration> {
  const endpoint = input.discovery.registrationEndpoint;
  if (!endpoint) {
    return {
      ok: false,
      unsupported: true,
      problem: `${input.discovery.issuer} doesn't offer dynamic client registration; register a client with it and give its id`,
    };
  }
  const method = chooseTokenEndpointAuthMethod(
    input.discovery.tokenEndpointAuthMethods,
  );
  if (!method) {
    return {
      ok: false,
      problem: `${input.discovery.issuer} takes clients by ${input.discovery.tokenEndpointAuthMethods.join(", ")} only; the Gateway's clients use client_secret_basic, client_secret_post or none`,
    };
  }
  const body = {
    client_name: input.clientName.slice(0, 100),
    redirect_uris: [input.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(input.discovery.scopes.length > 0
      ? { scope: input.discovery.scopes.join(" ") }
      : {}),
  };
  const fetched = await fetchJson(input.fetch, endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (fetched.kind === "failed") return { ok: false, problem: fetched.problem };
  if (fetched.kind === "missing") {
    return {
      ok: false,
      problem: `${endpoint} refused the registration (${fetched.status})`,
    };
  }
  const answer = fetched.body;
  const clientId = answer["client_id"];
  if (typeof clientId !== "string" || !clientId || clientId.length > 500) {
    return { ok: false, problem: `${endpoint} answered without a client_id` };
  }
  const said = answer["token_endpoint_auth_method"];
  const authMethod = typeof said === "string" && said ? said : method;
  if (
    !["client_secret_basic", "client_secret_post", "none"].includes(authMethod)
  ) {
    return {
      ok: false,
      problem: `${endpoint} registered the client for ${authMethod}, which the Gateway doesn't use`,
    };
  }
  const secret = answer["client_secret"];
  const clientSecret =
    typeof secret === "string" && secret.length > 0 ? secret : undefined;
  if (authMethod !== "none" && !clientSecret) {
    return {
      ok: false,
      problem: `${endpoint} registered a confidential client (${authMethod}) but returned no client_secret`,
    };
  }
  return {
    ok: true,
    clientId,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    inject: authMethod === "client_secret_basic" ? "basic" : "form",
    authMethod,
  };
}

/** A built spec, checked by `parseProviderSpec`, or why it can't be. */
export type McpProviderSpecResult =
  | { ok: true; id: string; spec: Record<string, unknown> }
  | { ok: false; problem: string };

function specName(name: string, suffix: string): string {
  const room = 64 - suffix.length;
  const trimmed = name.trim() || "MCP";
  return `${trimmed.length > room ? trimmed.slice(0, room).trimEnd() : trimmed}${suffix}`;
}

function checked(
  id: string,
  spec: Record<string, unknown>,
): McpProviderSpecResult {
  const parsed = parseProviderSpec(spec);
  if (!parsed.ok) {
    return { ok: false, problem: describeSpecProblems(parsed.problems) };
  }
  return { ok: true, id, spec };
}

function hostAndOrigin(
  url: string,
): { ok: true; host: string; origin: string } | { ok: false; problem: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, problem: `${url} isn't a URL` };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      problem: `${url} isn't https: a credential goes to an https server only`,
    };
  }
  return {
    ok: true,
    host: parsed.hostname.toLowerCase().replace(/\.$/, ""),
    origin: parsed.origin,
  };
}

/**
 * The `oauth2-user` spec of an app's own OAuth row (`<appId>-mcp`): the
 * MCP URL's host as its one API host (the token goes there and nowhere
 * else), the discovered endpoints, the client in `<APPID>_MCP_CLIENT_ID`
 * (and `_SECRET` for a confidential client), PKCE, the `resource` and
 * `issuer`. The scopes the connect asks for are the app's (its manifest's
 * entry, from discovery); the ones the server says it supports are
 * tolerated on a token.
 */
export function mcpOAuthProviderSpec(input: {
  appId: string;
  name: string;
  url: string;
  discovery: McpOAuthDiscovery;
  client: { hasSecret: boolean; inject: OAuthClientInjection };
}): McpProviderSpecResult {
  const where = hostAndOrigin(input.url);
  if (!where.ok) return where;
  const id = remoteMcpProviderId(input.appId);
  // Bounded as a spec's scope list is (40).
  const tolerated = [
    ...new Set([
      ...input.discovery.scopes,
      ...(input.discovery.supportedScopes ?? []),
    ]),
  ].slice(0, 40);
  const spec: Record<string, unknown> = {
    id,
    name: specName(input.name || input.appId, " MCP server"),
    docs: where.origin,
    hosts: [where.host],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: input.discovery.authorizationEndpoint,
      tokenUrl: input.discovery.tokenEndpoint,
      ...(input.discovery.revocationEndpoint
        ? { revokeUrl: input.discovery.revocationEndpoint }
        : {}),
      clientId: remoteMcpClientIdSetting(input.appId),
      ...(input.client.hasSecret
        ? { clientSecret: remoteMcpClientSecretSetting(input.appId) }
        : {}),
      inject: input.client.inject,
      pkce: true,
      scopeSeparator: "space",
      resource: input.discovery.resource,
      issuer: input.discovery.issuer,
      ...(tolerated.length > 0 ? { tolerated } : {}),
    },
    tags: ["mcp"],
  };
  return checked(id, spec);
}

/**
 * The API-key spec of an app's own static credential (`<appId>-mcp`): the
 * MCP URL's host as its one host, the value in `<APPID>_MCP_TOKEN`, placed
 * as `kind` says: `Authorization: Bearer` (or `<prefix>` as the scheme),
 * a header (`header`, `prefix`), a query parameter (`param`), or HTTP
 * Basic with the value as `user:password`.
 */
export function mcpStaticProviderSpec(input: {
  appId: string;
  name: string;
  url: string;
  kind: RemoteMcpStaticKind;
  header?: string | null;
  prefix?: string | null;
  param?: string | null;
}): McpProviderSpecResult {
  const where = hostAndOrigin(input.url);
  if (!where.ok) return where;
  const id = remoteMcpProviderId(input.appId);
  const secret = remoteMcpTokenSetting(input.appId);
  let auth: Record<string, unknown>;
  switch (input.kind) {
    case "bearer": {
      const scheme = (input.prefix ?? "").trim();
      auth = {
        kind: "bearer",
        secret,
        ...(scheme && scheme.toLowerCase() !== "bearer" ? { scheme } : {}),
      };
      break;
    }
    case "header": {
      const problem = remoteMcpHeaderProblem(input.header);
      if (problem) return { ok: false, problem };
      auth = {
        kind: "header",
        secret,
        header: input.header,
        ...(input.prefix ? { prefix: input.prefix } : {}),
      };
      break;
    }
    case "query": {
      if (!input.param) {
        return { ok: false, problem: "name the query parameter (--param)" };
      }
      auth = { kind: "query", secret, param: input.param };
      break;
    }
    case "basic":
      auth = { kind: "basic", secret, as: "pair" };
      break;
    default:
      return {
        ok: false,
        problem: `${String(input.kind)} isn't a static credential kind`,
      };
  }
  const name = input.name.trim() || input.appId;
  const spec: Record<string, unknown> = {
    id,
    name: specName(name, " MCP server"),
    docs: where.origin,
    hosts: [where.host],
    auth,
    data: "per-call",
    hint: `The credential ${name}'s MCP server takes${input.kind === "basic" ? ", as user:password" : ""}. The Gateway sends it to ${where.host} only.`.slice(
      0,
      500,
    ),
    tags: ["mcp"],
  };
  return checked(id, spec);
}
