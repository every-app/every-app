/**
 * The OAuth authorization server for MCP clients and native apps, and the
 * resource server for `${GATEWAY_URL}/mcp`, both on
 * @cloudflare/workers-oauth-provider 1.2.x and both in this Worker. Built
 * once per isolate, and again when GATEWAY_URL or the set of resources
 * changes.
 *
 * Resources (docs/design/native-sign-in.md §5): `${GATEWAY_URL}/mcp`, the
 * default, which Claude requires to equal the URL the user typed (so a
 * connector is `${GATEWAY_URL}/mcp`, and every app the user reaches is
 * behind it); plus the origin of every active first-party app host
 * (resources.ts), the audience of a native app's token, which opens that
 * one app as the member and nothing else. App hosts' own `/mcp` take
 * personal tokens and same-origin sessions only; they offer no OAuth.
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
  type ValidatedAccessToken,
} from "@cloudflare/workers-oauth-provider";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import { isMcpDcrEnabled, isMcpOauthEnabled } from "@/server/oauth-flag";
import { serveGatewayMcp } from "@/server/toolbus/gateway-mcp";
import { currentAppResources, type ResourceScheme } from "./resources";
import { grantStands, mcpBearerValidator, type McpCaller } from "./validate";

export const OFFLINE_ACCESS_SCOPE = "offline_access";
/**
 * A native grant's one scope: full member scope on its app, as the one
 * scope rule gives a personal token (`packages/perimeter/src/session.ts`).
 * Supported so the consent decision may approve it; never granted to an
 * MCP connection (consent.ts grantedScopes).
 */
export const NATIVE_SCOPE = "*";
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
  /** `${issuer}/mcp`, the resource AI apps connect to (the default). */
  resource: string;
  /** The scheme app resources are built on: the issuer's. */
  resourceScheme: ResourceScheme;
  /**
   * The app resources this build knows: the origin of every active
   * first-party app host, and the linked dev resource of every app whose
   * organization opted in, when the list was read. A token for a resource
   * not here is refused; `refreshMcpAuth` re-reads the list.
   */
  appResources: readonly string[];
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
  appResources: readonly string[],
): McpAuth {
  const resource = `${issuer}/mcp`;
  const authorizationServer = new OAuthAuthorizationServer<Cloudflare.Env>({
    issuer,
    // The registry is fixed at construction: a new app host means a new
    // build (refreshMcpAuth). /mcp first and the default, so MCP clients
    // that omit `resource` keep working.
    resources: [resource, ...appResources.filter((r) => r !== resource)],
    defaultResource: resource,
    // A grant stored before resource binding has no audience; with one
    // resource the library treated it as `/mcp`'s, with several it would
    // refuse it. Keep main's behaviour: such a grant stays an MCP grant.
    legacyGrantResource: resource,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    // Unset, the metadata names no registration endpoint.
    ...(dynamicRegistration
      ? { clientRegistrationEndpoint: REGISTRATION_PATH }
      : {}),
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
    scopesSupported: [
      MCP_READ_SCOPE,
      MCP_WRITE_SCOPE,
      OFFLINE_ACCESS_SCOPE,
      NATIVE_SCOPE,
    ],
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: accessTokenTtl(issuer, env.MCP_ACCESS_TOKEN_TTL),
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_TTL_SECONDS,
    cookiePrefix: "__Host-everyapp-oauth-",
    // A refresh for a connection that no longer stands (revoked, member
    // removed or deactivated; for a native grant, its app gone too) fails
    // with invalid_grant, which also revokes the grant: the client starts a
    // new authorization. One that can't be checked just now (D1 down) is
    // temporarily_unavailable, and the grant stays.
    tokenExchangeCallback: async ({ props, scope, resource: audience }) => {
      let stands;
      try {
        stands = await grantStands(props, scope, audience);
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
      if (!stands) {
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
      resource_name: "EveryApp",
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
    resourceScheme: new URL(issuer).protocol as ResourceScheme,
    appResources,
    dynamicRegistration,
  };
}

let built: { key: string; auth: McpAuth | null } | undefined;
/** The app resources the current build was made with (sorted). */
let builtAppResources: readonly string[] = [];

/**
 * The authorization and resource servers for this GATEWAY_URL, or null when
 * it can't be an OAuth issuer (OAuth then stays off; /mcp takes personal
 * tokens only). Built with the app resources last read from the registry
 * (none on a fresh isolate: `refreshMcpAuth` reads them); every route that
 * may name an app resource refreshes first.
 */
export function getMcpAuth(env: Cloudflare.Env): McpAuth | null {
  const issuer = canonicalIssuer(env.GATEWAY_URL);
  const dynamicRegistration = isMcpDcrEnabled(env);
  const key = [
    issuer,
    env.MCP_ACCESS_TOKEN_TTL ?? "",
    dynamicRegistration,
    ...builtAppResources,
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
      auth = build(issuer, env, dynamicRegistration, builtAppResources);
    } catch (error) {
      // An app resource the library refuses must not take /mcp down: build
      // without the app resources (no native sign-in until the list is
      // fixed), and say so.
      logEvent(
        "mcp.oauth.app_resources_refused",
        {
          resources: builtAppResources,
          reason: error instanceof Error ? error.message : String(error),
        },
        "error",
      );
      try {
        auth = build(issuer, env, dynamicRegistration, []);
      } catch (inner) {
        logEvent(
          "mcp.oauth.unavailable",
          { reason: inner instanceof Error ? inner.message : String(inner) },
          "error",
        );
      }
    }
  }
  built = { key, auth };
  return auth;
}

/**
 * The servers, built with the app resources the registry has now: the
 * cached list, re-read when it is a minute old or when `needed` names an
 * origin it doesn't have (resources.ts). The build is replaced only when
 * the set changed; grants and tokens live in KV, so a rebuild loses
 * nothing. `needed` is what a request named (`resource` on authorize or
 * the token endpoint, the host a token is presented on), so a just-deployed
 * app's first sign-in doesn't wait for the minute.
 */
export async function refreshMcpAuth(
  env: Cloudflare.Env,
  needed?: string | null,
): Promise<McpAuth | null> {
  const issuer = canonicalIssuer(env.GATEWAY_URL);
  if (!issuer) return getMcpAuth(env);
  const scheme = new URL(issuer).protocol as ResourceScheme;
  const origins = await currentAppResources(scheme, { needed, issuer });
  if (
    origins.length !== builtAppResources.length ||
    origins.some((origin, index) => origin !== builtAppResources[index])
  ) {
    builtAppResources = origins;
  }
  return getMcpAuth(env);
}

/**
 * The servers for a token presented on an app host (the perimeter's
 * authenticator): the build that knows `resource` when the registry does.
 * Validate with `authorizationServer.validateToken(resource, token, env)`
 * and resolve the member with `resolveNativeCaller` (validate.ts). Null
 * when OAuth is off here (MCP_OAUTH_ENABLED, or a GATEWAY_URL that can't
 * be an issuer): then no native app can sign in, and no token validates.
 */
export async function mcpAuthForResource(
  env: Cloudflare.Env,
  resource: string,
): Promise<McpAuth | null> {
  if (!isMcpOauthEnabled(env)) return null;
  return refreshMcpAuth(env, resource);
}

/**
 * Validate a bearer presented on an app host for that host's resource: the
 * perimeter's one call (lane b). Null for a token of another audience,
 * expired or unknown, for an origin that is not an active first-party app
 * host (the library throws for an undeclared resource; here that is null,
 * fail closed), and when OAuth is off. The props of a validated token are
 * then resolved with `resolveNativeCaller` (validate.ts).
 */
export async function validateAppHostToken(
  env: Cloudflare.Env,
  resource: string,
  token: string,
): Promise<ValidatedAccessToken | null> {
  const mcpAuth = await mcpAuthForResource(env, resource);
  if (!mcpAuth || !mcpAuth.appResources.includes(resource)) return null;
  return mcpAuth.authorizationServer.validateToken(resource, token, env);
}

/**
 * Validate a bearer presented at `/linked-dev/<app id>/…` for that app's
 * linked dev resource (docs/design/linked-dev.md): null for a token of
 * another audience (an app host's, `/mcp`), expired or unknown, for an
 * app whose organization didn't turn linked dev on (the resource isn't
 * listed), and when OAuth is off. The props of a validated token are then
 * resolved with `resolveDevCaller` (validate.ts).
 */
export async function validateLinkedDevToken(
  env: Cloudflare.Env,
  resource: string,
  token: string,
): Promise<ValidatedAccessToken | null> {
  const mcpAuth = await mcpAuthForResource(env, resource);
  if (!mcpAuth || !mcpAuth.appResources.includes(resource)) return null;
  return mcpAuth.authorizationServer.validateToken(resource, token, env);
}

export function resetMcpAuthForTests(): void {
  built = undefined;
  builtAppResources = [];
}

export const MCP_OAUTH_PATHS = {
  authorize: AUTHORIZE_PATH,
  token: TOKEN_PATH,
  registration: REGISTRATION_PATH,
} as const;
