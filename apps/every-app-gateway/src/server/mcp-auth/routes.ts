/**
 * The gateway host's MCP and OAuth routes, ahead of the TanStack control
 * plane:
 *
 * | Path                                              | Served by                                   |
 * | ------------------------------------------------- | ------------------------------------------- |
 * | `/mcp`                                            | the resource server (OAuth + PAT)           |
 * | `/.well-known/oauth-protected-resource/mcp`       | the resource server (RFC 9728)              |
 * | `/.well-known/oauth-authorization-server`         | the authorization server                    |
 * | `/oauth/token` (and revocation)                   | the authorization server                    |
 * | `/oauth/register` (unless MCP_DCR_ENABLED is off) | the authorization server, within limits     |
 * | `GET /oauth/authorize`                            | authorize.ts, then the page                 |
 * | `POST /oauth/consent/decision`                    | authorize.ts                                |
 * | `/oauth/consent`                                  | the TanStack page (null here)               |
 * | `/oauth/app-access`                               | the TanStack page (null here), always       |
 *
 * Any other `/mcp/*`, `/oauth/*` or OAuth discovery path is 404. With
 * MCP_OAUTH_ENABLED off (or a GATEWAY_URL OAuth can't use), every OAuth path
 * but `/oauth/app-access` is 404 and `/mcp` accepts personal access tokens
 * only. That page is where a person allows an app to use their connection
 * to an OAuth provider (server/oauth/flow.ts): it is no part of the
 * Gateway's own OAuth server, and is served whether that is on or off.
 *
 * Behind Cloudflare Access, `/mcp`, `/oauth/token`, `/oauth/register` and
 * `/.well-known/*` are bypassed (packages/perimeter/src/install/access-plan.ts):
 * they check their own credentials. An Access assertion on them is never
 * read here.
 *
 * A failure (D1 or KV down, say) answers as each route's callers expect: an
 * error page where a browser is, an OAuth or JSON-RPC error elsewhere.
 */
import { env, waitUntil } from "cloudflare:workers";
import { extractBearerCredential, logEvent } from "@every-app/perimeter";
import { ALLOW_PAGE } from "@/schemas/app-access";
import { isMcpOauthEnabled, isOauthPath } from "@/server/oauth-flag";
import { serveGatewayMcp } from "@/server/toolbus/gateway-mcp";
import { errorPage, handleAuthorize, handleConsentDecision } from "./authorize";
import { payloadTooLarge, readBodyWithLimit, withBody } from "./body";
import { MCP_OAUTH_PATHS, refreshMcpAuth, type McpAuth } from "./config";
import { onPlatformDomain, tokenRequestClientIds } from "./own-domain";
import { normalizeClientRegistrationRequest } from "./registration";
import { allowRegistration } from "./registration-limit";
import { resolvePatCaller } from "./validate";

const MCP_PATH = "/mcp";
const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/mcp";
const AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";
const CONSENT_PAGE_PATH = "/oauth/consent";
const CONSENT_DECISION_PATH = "/oauth/consent/decision";
/** Far more than any token request (a client assertion included) needs. */
const MAX_TOKEN_BODY_BYTES = 64 * 1024;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

/**
 * A fresh context per request: the resource server sets `props` and `auth`
 * on it, and nothing else must see them.
 */
function requestContext(): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => waitUntil(promise),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

/** Answer a browser's preflight as the resource server does. */
function preflight(request: Request): Response {
  const origin = request.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: origin
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, *",
          "access-control-max-age": "600",
          vary: "Origin",
        }
      : {},
  });
}

/**
 * `/mcp` without OAuth: personal access tokens only, and a 401 that names no
 * authorization server, so a client fails fast instead of half-registering.
 */
async function serveMcpWithTokensOnly(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return preflight(request);
  const token = extractBearerCredential(request.headers);
  const caller = token?.startsWith("epat_")
    ? await resolvePatCaller(token)
    : null;
  if (!caller) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": token
          ? 'Bearer realm="every-app", error="invalid_token"'
          : 'Bearer realm="every-app"',
      },
    });
  }
  return serveGatewayMcp(request, caller);
}

/**
 * Serve an MCP or OAuth route on the gateway host, or return null for the
 * control plane to serve.
 */
export async function serveMcpAuthRoute(
  request: Request,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(`${MCP_PATH}/`)) {
    return json(404, { error: "not_found" });
  }
  if (pathname !== MCP_PATH && !isOauthPath(pathname)) return null;
  if (pathname === ALLOW_PAGE) return null;
  try {
    return await dispatch(request, pathname);
  } catch (error) {
    logEvent(
      "mcp.route.failed",
      {
        path: pathname,
        message: error instanceof Error ? error.message : String(error),
      },
      "error",
    );
    return unavailable(pathname);
  }
}

/**
 * The resource an authorization request names, so the servers can be
 * rebuilt with a just-deployed app's origin before the request is parsed
 * (config.ts refreshMcpAuth). The token endpoint's is in its body, read
 * there.
 */
function resourceNamed(request: Request, pathname: string): string | null {
  if (pathname !== MCP_OAUTH_PATHS.authorize) return null;
  return new URL(request.url).searchParams.get("resource");
}

async function dispatch(
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const mcpAuth = isMcpOauthEnabled(env)
    ? await refreshMcpAuth(env, resourceNamed(request, pathname))
    : null;
  if (pathname === MCP_PATH) {
    return mcpAuth
      ? mcpAuth.resourceServer.fetch(request, env, requestContext())
      : serveMcpWithTokensOnly(request);
  }
  if (!mcpAuth) return json(404, { error: "oauth_disabled" });

  switch (pathname) {
    case PROTECTED_RESOURCE_METADATA_PATH:
      return mcpAuth.resourceServer.fetch(request, env, requestContext());
    case AUTHORIZATION_SERVER_METADATA_PATH:
      return withoutAppResources(
        await mcpAuth.authorizationServer.fetch(request, env, requestContext()),
        mcpAuth,
      );
    case MCP_OAUTH_PATHS.token:
      return serveTokenEndpoint(request, mcpAuth);
    case MCP_OAUTH_PATHS.registration:
      return mcpAuth.dynamicRegistration
        ? serveRegistration(request, mcpAuth)
        : json(404, { error: "registration_disabled" });
    case MCP_OAUTH_PATHS.authorize:
      return request.method === "GET"
        ? handleAuthorize(request, mcpAuth)
        : new Response(null, { status: 405, headers: { allow: "GET" } });
    case CONSENT_DECISION_PATH:
      return request.method === "POST"
        ? handleConsentDecision(request, mcpAuth)
        : new Response(null, { status: 405, headers: { allow: "POST" } });
    case CONSENT_PAGE_PATH:
      return null;
    default:
      return json(404, { error: "not_found" });
  }
}

/**
 * The authorization server's metadata without the app hosts: the library
 * lists every configured resource under `protected_resources`, which would
 * publish the hostname of every active app on this gateway to anyone (the
 * document is public, and bypassed behind Access). A native app never
 * reads it: it finds the gateway from the metadata its own app host
 * serves (docs/design/native-sign-in.md §4), so only `/mcp` is named, as
 * before native sign-in.
 */
async function withoutAppResources(
  response: Response,
  mcpAuth: McpAuth,
): Promise<Response> {
  if (response.status !== 200) return response;
  let metadata: Record<string, unknown>;
  try {
    metadata = (await response.clone().json()) as Record<string, unknown>;
  } catch {
    return response;
  }
  if (!Array.isArray(metadata["protected_resources"])) return response;
  return new Response(
    JSON.stringify({ ...metadata, protected_resources: [mcpAuth.resource] }),
    { status: 200, headers: response.headers },
  );
}

/**
 * Dynamic client registration: the body reduced to what Every App keeps
 * (registration.ts), then counted against the registration budget
 * (registration-limit.ts), which only a registration that is made spends.
 */
async function serveRegistration(
  request: Request,
  mcpAuth: McpAuth,
): Promise<Response> {
  if (request.method !== "POST") {
    return mcpAuth.authorizationServer.fetch(request, env, requestContext());
  }
  const normalized = await normalizeClientRegistrationRequest(request);
  if (normalized instanceof Response) return normalized;
  const allowance = await allowRegistration(request);
  if (!allowance.allowed) return allowance.response;
  const response = await mcpAuth.authorizationServer.fetch(
    normalized,
    env,
    requestContext(),
  );
  if (response.status === 201) await allowance.spend();
  return response;
}

/**
 * The token endpoint (and revocation), its body read with a cap first. A
 * client id on the platform's domains is refused before the library could
 * fetch it as a metadata document.
 */
async function serveTokenEndpoint(
  request: Request,
  initial: McpAuth,
): Promise<Response> {
  let mcpAuth = initial;
  if (request.method !== "POST") {
    return mcpAuth.authorizationServer.fetch(request, env, requestContext());
  }
  const body = await readBodyWithLimit(request, MAX_TOKEN_BODY_BYTES);
  if (!body) return payloadTooLarge("64 KiB");
  // A refresh naming a just-deployed app's origin: the servers are rebuilt
  // with it first, so the audience is known (an unknown one is
  // invalid_target).
  const named = new URLSearchParams(new TextDecoder().decode(body)).get(
    "resource",
  );
  if (named && !mcpAuth.appResources.includes(named.toLowerCase())) {
    mcpAuth = (await refreshMcpAuth(env, named)) ?? mcpAuth;
  }
  if (
    tokenRequestClientIds(request.headers, body).some((clientId) =>
      onPlatformDomain(clientId, mcpAuth.issuer, env),
    )
  ) {
    logEvent(
      "mcp.oauth.error",
      {
        status: 401,
        error: "invalid_client",
        category: "client-authentication",
        reason: "client_on_platform_domain",
      },
      "warn",
    );
    return Response.json(
      { error: "invalid_client", error_description: "Client not found" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  return mcpAuth.authorizationServer.fetch(
    withBody(request, body),
    env,
    requestContext(),
  );
}

/** What a failed route answers, in the shape its callers read. */
function unavailable(pathname: string): Response {
  if (
    pathname === MCP_OAUTH_PATHS.authorize ||
    pathname === CONSENT_DECISION_PATH
  ) {
    return errorPage(
      503,
      "Something went wrong",
      "EveryApp couldn't finish this just now. Start connecting again from your AI app in a moment.",
    );
  }
  if (pathname === MCP_PATH) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "EveryApp is unavailable just now." },
      },
      { status: 503, headers: { "retry-after": "30" } },
    );
  }
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description: "Try again in a moment.",
    },
    {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "30" },
    },
  );
}
