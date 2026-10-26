/**
 * The OAuth authorization server for MCP clients and the one resource it
 * protects, `${GATEWAY_URL}/mcp`, both on @cloudflare/workers-oauth-provider
 * 1.2.x and both in this Worker. Built once per isolate (and again if
 * GATEWAY_URL changes).
 *
 * One resource, on purpose: Claude requires the protected resource
 * metadata's `resource` to equal the URL the user typed, path included, so a
 * connector is `${GATEWAY_URL}/mcp`, and every app the user reaches is behind
 * it. App hosts' `/mcp` take personal tokens and same-origin sessions only;
 * they offer no OAuth.
 *
 * Clients register with a Client ID Metadata Document (CIMD: claude.ai,
 * Claude Desktop and mobile, Claude Code, ChatGPT, VS Code, Codex), which
 * needs the `global_fetch_strictly_public` compatibility flag, or
 * dynamically (DCR: Cursor, Gemini CLI, MCP Inspector, older clients),
 * unless MCP_DCR_ENABLED turns that off.
 */
import {
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
} from "@cloudflare/workers-oauth-provider";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import { isMcpDcrEnabled } from "@/server/oauth-flag";
import { serveGatewayMcp } from "@/server/toolbus/gateway-mcp";
import {
  mcpBearerValidator,
  resolveOauthCaller,
  type McpCaller,
} from "./validate";

export const OFFLINE_ACCESS_SCOPE = "offline_access";
const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/oauth/token";
const REGISTRATION_PATH = "/oauth/register";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
// A grant lives 30 days from consent, and each refresh moves that to 30
// days later: a connection in use keeps working, an idle one lapses.
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_TOKEN_TTL_SECONDS = 60;
// A dynamically registered client lasts 60 days unused. The library renews
// a registration for the full TTL on a successful token request once half
// of it has passed, so a registration always outlives its client's grants
// (30 days idle) as long as it is at least twice their lifetime; any
// shorter, and an idle but valid grant could lose its client and fail to
// refresh.
const CLIENT_REGISTRATION_TTL_SECONDS = 2 * REFRESH_TOKEN_TTL_SECONDS;

export interface McpAuth {
  authorizationServer: OAuthAuthorizationServer<Cloudflare.Env>;
  resourceServer: OAuthResourceServer<Cloudflare.Env, McpCaller>;
  /** The canonical issuer: GATEWAY_URL's origin. */
  issuer: string;
  /** `${issuer}/mcp`, the one protected resource. */
  resource: string;
  /** Whether clients may register dynamically (/oauth/register). */
  dynamicRegistration: boolean;
}

/**
 * GATEWAY_URL's origin as an OAuth issuer, or null when it can't be one:
 * OAuth needs https, or http on exactly `localhost` / `127.0.0.1` (not
 * `*.localhost`) for local testing.
 */
function canonicalIssuer(gatewayUrl: string | undefined): string | null {
  if (!gatewayUrl) return null;
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return null;
  }
  return url.origin;
}

/**
 * Local testing only: MCP_ACCESS_TOKEN_TTL shortens access tokens (to no
 * less than a minute) so a refresh can be watched, and is ignored unless
 * the gateway runs on a loopback http issuer.
 */
function accessTokenTtl(issuer: string, override: string | undefined): number {
  const seconds = Number(override);
  if (!issuer.startsWith("http://") || !Number.isInteger(seconds)) {
    return ACCESS_TOKEN_TTL_SECONDS;
  }
  return Math.min(
    Math.max(seconds, MIN_TOKEN_TTL_SECONDS),
    ACCESS_TOKEN_TTL_SECONDS,
  );
}

function logOauthError({
  code,
  status,
  internal,
}: {
  code: string;
  status: number;
  internal: { category: string; reason: string };
}): void {
  // An expired or revoked token on /mcp, or a stale client registration, is
  // routine: the client signs in again. Everything else is worth a look.
  // `error`, not `code`: log fields named like credentials are redacted.
  logEvent(
    "mcp.oauth.error",
    {
      status,
      error: code,
      category: internal.category,
      reason: internal.reason,
    },
    status >= 500 ? "error" : status === 401 ? "log" : "warn",
  );
}

function build(
  issuer: string,
  env: Cloudflare.Env,
  dynamicRegistration: boolean,
): McpAuth {
  const resource = `${issuer}/mcp`;
  const authorizationServer = new OAuthAuthorizationServer<Cloudflare.Env>({
    issuer,
    resources: [resource],
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    // Unset, the metadata names no registration endpoint.
    ...(dynamicRegistration
      ? { clientRegistrationEndpoint: REGISTRATION_PATH }
      : {}),
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
    scopesSupported: [MCP_READ_SCOPE, MCP_WRITE_SCOPE, OFFLINE_ACCESS_SCOPE],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: accessTokenTtl(issuer, env.MCP_ACCESS_TOKEN_TTL),
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_TTL_SECONDS,
    cookiePrefix: "__Host-everyapp-oauth-",
    // A refresh for a connection that no longer stands (revoked, member
    // removed or deactivated) fails with invalid_grant, which also revokes
    // the grant: the client starts a new authorization. One that can't be
    // checked just now (D1 down) is temporarily_unavailable, and the grant
    // stays.
    tokenExchangeCallback: async ({ props, scope }) => {
      let caller;
      try {
        caller = await resolveOauthCaller(props, scope);
      } catch (error) {
        logEvent(
          "mcp.oauth.connection_unreadable",
          { message: error instanceof Error ? error.message : String(error) },
          "error",
        );
        throw new OAuthError("temporarily_unavailable", {
          description: "Try again in a moment.",
          statusCode: 503,
          headers: { "retry-after": "30" },
        });
      }
      if (!caller || caller === "insufficient_scope") {
        throw new OAuthError("invalid_grant", {
          description: "This connection was revoked. Connect again.",
        });
      }
    },
    onError: logOauthError,
  });

  const resourceServer = new OAuthResourceServer<Cloudflare.Env, McpCaller>({
    resourceMetadata: {
      resource,
      authorization_servers: [issuer],
      resource_name: "Every App",
    },
    // Advertised in the 401 challenge and the protected-resource metadata,
    // not enforced (the validator below takes a token with either): clients
    // request what is named here, and a grant is requested ∩ approved
    // (grantedScopes), so both must be named for the consent page to be able
    // to offer read & write at all.
    requiredScopes: [MCP_READ_SCOPE, MCP_WRITE_SCOPE],
    validateToken: (requestEnv) =>
      mcpBearerValidator(authorizationServer, requestEnv),
    handler: {
      // The token's expiry bounds a held subscriptions/listen stream.
      fetch: (request, _env, ctx) =>
        serveGatewayMcp(request, ctx.props, {
          credentialExpiresAt: ctx.auth.expiresAt,
        }),
    },
  });

  return {
    authorizationServer,
    resourceServer,
    issuer,
    resource,
    dynamicRegistration,
  };
}

let built: { key: string; auth: McpAuth | null } | undefined;

/**
 * The authorization and resource servers for this GATEWAY_URL, or null when
 * it can't be an OAuth issuer (OAuth then stays off; /mcp takes personal
 * tokens only).
 */
export function getMcpAuth(env: Cloudflare.Env): McpAuth | null {
  const issuer = canonicalIssuer(env.GATEWAY_URL);
  const dynamicRegistration = isMcpDcrEnabled(env);
  const key = [
    issuer,
    env.MCP_ACCESS_TOKEN_TTL ?? "",
    dynamicRegistration,
  ].join("\u0000");
  if (built?.key === key) return built.auth;

  let auth: McpAuth | null = null;
  if (!issuer) {
    logEvent(
      "mcp.oauth.unavailable",
      {
        reason:
          "GATEWAY_URL must be https, or http on localhost or 127.0.0.1, for OAuth",
      },
      "warn",
    );
  } else {
    try {
      auth = build(issuer, env, dynamicRegistration);
    } catch (error) {
      logEvent(
        "mcp.oauth.unavailable",
        { reason: error instanceof Error ? error.message : String(error) },
        "error",
      );
    }
  }
  built = { key, auth };
  return auth;
}

export const MCP_OAUTH_PATHS = {
  authorize: AUTHORIZE_PATH,
  token: TOKEN_PATH,
  registration: REGISTRATION_PATH,
} as const;
