// The client half of "Sign in with Every App" (docs/scribe.md), ported from
// mac/Sources/HelperCore/OAuthClient.swift. OAuth 2.0 for a public native client: protected
// resource discovery on the app (RFC 9728), the Gateway's metadata (RFC 8414), dynamic
// registration once per install (RFC 7591), authorization code + PKCE S256 (RFC 7636) to a
// loopback redirect (RFC 8252), `resource` on every request (RFC 8707), `iss` on the callback
// (RFC 9207). No `scope` anywhere: the grant is for the app. Only the HTTP lives here.

import type { Pkce } from "./pkce";
import { authorizationServerMetadataUrl, isSignInEndpoint, normalized } from "./url";

export type Fetch = typeof fetch;

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  codeChallengeMethodsSupported?: string[];
  /** RFC 9207: the callback carries `iss`. */
  authorizationResponseIssParameterSupported?: boolean;
}

/** What the secret store keeps for a Sign in with Every App session. Times are epoch ms. */
export interface OAuthGrant {
  appUrl: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  resource: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

/** Refresh a minute early, so a token never expires mid-request. */
export function needsRefresh(grant: OAuthGrant, now = Date.now()): boolean {
  return grant.expiresAt !== undefined && grant.expiresAt - now < 60_000;
}

export type OAuthErrorKind =
  | "discoveryFailed"
  | "registrationFailed"
  | "invalidGrant"
  | "invalidClient"
  | "tokenFailed"
  | "noPKCE";

export class OAuthError extends Error {
  constructor(
    readonly kind: OAuthErrorKind,
    detail = "",
  ) {
    super(OAuthError.describe(kind, detail));
    this.name = "OAuthError";
  }

  static describe(kind: OAuthErrorKind, detail: string): string {
    switch (kind) {
      case "discoveryFailed":
        return `Couldn't find Every App sign-in for that app. ${detail}`.trim();
      case "registrationFailed":
        return `The Gateway wouldn't register Every App. ${detail}`.trim();
      case "invalidGrant":
        return "The Gateway ended this sign-in. Sign in again.";
      case "invalidClient":
        return "The Gateway no longer knows this Mac. Sign in again.";
      case "tokenFailed":
        return `The Gateway didn't issue a token. ${detail}`.trim();
      case "noPKCE":
        return "The Gateway doesn't support PKCE (S256), which Every App needs.";
    }
  }
}

export const CLIENT_NAME = "Every App";
/** Registered once; the Gateway matches it on any loopback port (RFC 8252 §7.3). */
export const REGISTERED_REDIRECT_URI = "http://127.0.0.1/callback";

type Json = Record<string, unknown>;

export class OAuthClient {
  constructor(private readonly fetchImpl: Fetch = fetch) {}

  /** Step 1: the app names its authorization server. `resource` must be the app's origin. */
  async discoverResource(origin: string): Promise<ProtectedResourceMetadata> {
    const json = await this.getJSON(`${normalized(origin)}/.well-known/oauth-protected-resource`, "the app's sign-in metadata");
    const resource = typeof json.resource === "string" ? json.resource : undefined;
    const servers = Array.isArray(json.authorization_servers)
      ? json.authorization_servers.filter((s): s is string => typeof s === "string")
      : undefined;
    if (!resource || !servers) throw new OAuthError("discoveryFailed", "Couldn't read the app's sign-in metadata.");
    if (normalized(resource) !== normalized(origin)) {
      throw new OAuthError("discoveryFailed", `The app says it is ${resource}, not ${normalized(origin)}.`);
    }
    if (servers.length === 0) throw new OAuthError("discoveryFailed", "The app names no Gateway.");
    if (!isSignInEndpoint(servers[0])) throw new OAuthError("discoveryFailed", `The app names a Gateway that isn't https: ${servers[0]}.`);
    return { resource, authorizationServers: servers };
  }

  /** Step 2: the Gateway's endpoints. Its `issuer` must be the Gateway the app named. */
  async discover(issuer: string): Promise<AuthorizationServerMetadata> {
    const json = await this.getJSON(authorizationServerMetadataUrl(issuer), "the Gateway's metadata");
    const s = (k: string) => (typeof json[k] === "string" ? (json[k] as string) : undefined);
    const metadata: AuthorizationServerMetadata = {
      issuer: s("issuer") ?? "",
      authorizationEndpoint: s("authorization_endpoint") ?? "",
      tokenEndpoint: s("token_endpoint") ?? "",
      registrationEndpoint: s("registration_endpoint"),
      revocationEndpoint: s("revocation_endpoint"),
      codeChallengeMethodsSupported: Array.isArray(json.code_challenge_methods_supported)
        ? json.code_challenge_methods_supported.filter((m): m is string => typeof m === "string")
        : undefined,
      authorizationResponseIssParameterSupported:
        typeof json.authorization_response_iss_parameter_supported === "boolean"
          ? json.authorization_response_iss_parameter_supported
          : undefined,
    };
    if (!metadata.issuer || !metadata.authorizationEndpoint || !metadata.tokenEndpoint) {
      throw new OAuthError("discoveryFailed", "Couldn't read the Gateway's metadata.");
    }
    for (const url of [metadata.issuer, metadata.authorizationEndpoint, metadata.tokenEndpoint, metadata.registrationEndpoint, metadata.revocationEndpoint]) {
      if (url !== undefined && !isSignInEndpoint(url)) {
        throw new OAuthError("discoveryFailed", `The Gateway's metadata names an endpoint that isn't https: ${url}.`);
      }
    }
    if (normalized(metadata.issuer) !== normalized(issuer)) {
      throw new OAuthError("discoveryFailed", `The Gateway calls itself ${metadata.issuer}, not ${issuer}.`);
    }
    if (metadata.codeChallengeMethodsSupported && !metadata.codeChallengeMethodsSupported.includes("S256")) {
      throw new OAuthError("noPKCE");
    }
    return metadata;
  }

  /** Registers this install as a public client, once per Gateway; the caller caches the id. */
  async register(endpoint: string): Promise<string> {
    const body = {
      client_name: CLIENT_NAME,
      redirect_uris: [REGISTERED_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new OAuthError("registrationFailed", errorMessage(error));
    }
    const text = await response.text();
    const json = parseJSON(text);
    const clientId = json && typeof json.client_id === "string" ? json.client_id : "";
    if (!response.ok || !clientId) throw new OAuthError("registrationFailed", problem(json, response.status));
    return clientId;
  }

  static authorizationUrl(args: {
    metadata: AuthorizationServerMetadata;
    clientId: string;
    redirectUri: string;
    pkce: Pkce;
    state: string;
    resource: string;
  }): string {
    const url = new URL(args.metadata.authorizationEndpoint);
    const q = url.searchParams;
    q.append("response_type", "code");
    q.append("client_id", args.clientId);
    q.append("redirect_uri", args.redirectUri);
    q.append("code_challenge", args.pkce.challenge);
    q.append("code_challenge_method", args.pkce.method);
    q.append("state", args.state);
    q.append("resource", args.resource);
    return url.toString();
  }

  async exchange(args: {
    code: string;
    metadata: AuthorizationServerMetadata;
    clientId: string;
    redirectUri: string;
    pkce: Pkce;
    resource: string;
    appUrl: string;
    now?: number;
  }): Promise<OAuthGrant> {
    const now = args.now ?? Date.now();
    const token = await this.tokenRequest(args.metadata.tokenEndpoint, args.resource, [
      ["grant_type", "authorization_code"],
      ["code", args.code],
      ["redirect_uri", args.redirectUri],
      ["client_id", args.clientId],
      ["code_verifier", args.pkce.verifier],
      ["resource", args.resource],
    ]);
    return {
      appUrl: args.appUrl,
      issuer: args.metadata.issuer,
      tokenEndpoint: args.metadata.tokenEndpoint,
      revocationEndpoint: args.metadata.revocationEndpoint,
      clientId: args.clientId,
      resource: args.resource,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresIn !== undefined ? now + token.expiresIn * 1000 : undefined,
      scope: token.scope,
    };
  }

  /** The new refresh token (the Gateway rotates them) replaces the old one in the returned grant;
   * the caller must store it before using the access token. */
  async refresh(grant: OAuthGrant, now = Date.now()): Promise<OAuthGrant> {
    if (!grant.refreshToken) throw new OAuthError("invalidGrant");
    if (!isSignInEndpoint(grant.tokenEndpoint)) throw new OAuthError("invalidGrant");
    const token = await this.tokenRequest(grant.tokenEndpoint, grant.resource, [
      ["grant_type", "refresh_token"],
      ["refresh_token", grant.refreshToken],
      ["client_id", grant.clientId],
      ["resource", grant.resource],
    ]);
    return {
      ...grant,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? grant.refreshToken,
      expiresAt: token.expiresIn !== undefined ? now + token.expiresIn * 1000 : undefined,
      scope: token.scope ?? grant.scope,
    };
  }

  /** RFC 7009, best effort: revokes the refresh token (and with it the grant). Signing out works
   * even if this fails. */
  async revoke(grant: OAuthGrant): Promise<void> {
    if (!grant.revocationEndpoint || !isSignInEndpoint(grant.revocationEndpoint)) return;
    const [token, hint] = grant.refreshToken
      ? [grant.refreshToken, "refresh_token"]
      : [grant.accessToken, "access_token"];
    try {
      await this.fetchImpl(grant.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formEncode([
          ["token", token],
          ["token_type_hint", hint],
          ["client_id", grant.clientId],
        ]),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Best effort.
    }
  }

  private async getJSON(url: string, what: string): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/json" }, redirect: "follow" });
    } catch (error) {
      throw new OAuthError("discoveryFailed", errorMessage(error));
    }
    if (response.status !== 200) {
      throw new OAuthError("discoveryFailed", `HTTP ${response.status} for ${what} at ${new URL(url).pathname}.`);
    }
    const json = parseJSON(await response.text());
    if (!json) throw new OAuthError("discoveryFailed", `Couldn't read ${what}.`);
    return json;
  }

  /** A token for another resource than the one asked for is refused. */
  private async tokenRequest(
    endpoint: string,
    resource: string,
    fields: [string, string][],
  ): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: formEncode(fields),
      });
    } catch (error) {
      throw new OAuthError("tokenFailed", errorMessage(error));
    }
    const json = parseJSON(await response.text());
    if (response.status >= 400 && response.status < 500 && json) {
      if (json.error === "invalid_grant") throw new OAuthError("invalidGrant");
      if (json.error === "invalid_client") throw new OAuthError("invalidClient");
    }
    if (response.status !== 200) throw new OAuthError("tokenFailed", problem(json, response.status));
    if (!json || typeof json.access_token !== "string" || !json.access_token) {
      throw new OAuthError("tokenFailed", "The response wasn't a token.");
    }
    if (typeof json.token_type === "string" && json.token_type.toLowerCase() !== "bearer") {
      throw new OAuthError("tokenFailed", `Unexpected token type ${json.token_type}.`);
    }
    if (typeof json.resource === "string" && normalized(json.resource) !== normalized(resource)) {
      throw new OAuthError("tokenFailed", `The token is for ${json.resource}, not ${resource}.`);
    }
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
      expiresIn: typeof json.expires_in === "number" ? json.expires_in : undefined,
      scope: typeof json.scope === "string" ? json.scope : undefined,
    };
  }
}

/** application/x-www-form-urlencoded, RFC 6749 appendix B. */
export function formEncode(fields: [string, string][]): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return fields.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
}

function parseJSON(text: string): Json | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** The server's own error code and description, never the token or the body at large. */
function problem(json: Json | undefined, status: number): string {
  if (json && typeof json.error === "string") {
    const description = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
    return `${json.error}${description}`;
  }
  return `HTTP ${status}.`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
