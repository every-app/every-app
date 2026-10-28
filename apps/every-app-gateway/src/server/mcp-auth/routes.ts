/**
 * The gateway host's MCP and OAuth routes, ahead of the TanStack control
 * plane:
 *
 * | Path                                              | Served by                                   |
 * | ------------------------------------------------- | ------------------------------------------- |
 * | `/mcp` with a verified Access assertion           | access-caller.ts (the person Access vouches |
 * |                                                   | for), behind the outer ring only            |
 * | `/mcp` otherwise                                  | the resource server (OAuth + PAT)           |
 * | `/.well-known/oauth-protected-resource/mcp`       | the resource server (RFC 9728)              |
 * | `/.well-known/oauth-authorization-server`         | the authorization server                    |
 * | `/oauth/token` (and revocation)                   | the authorization server                    |
 * | `/oauth/register` (unless MCP_DCR_ENABLED is off) | the authorization server, within limits     |
 * | `GET /oauth/authorize`                            | authorize.ts, then the page                 |
 * | `POST /oauth/consent/decision`                    | authorize.ts                                |
 * | `/oauth/consent`                                  | the TanStack page (null here)               |
 *
 * Any other `/mcp/*`, `/oauth/*` or OAuth discovery path is 404. With
 * MCP_OAUTH_ENABLED off (or a GATEWAY_URL OAuth can't use), every OAuth path
 * is 404 and `/mcp` accepts personal access tokens only.
 *
 * Where Cloudflare Access's Managed OAuth fronts the gateway's host (the
 * runbook's self-hosted setup with nothing bypassed), Access is the OAuth
 * server AI apps talk to; it serves the discovery documents on the hostname
 * itself, so the gateway's own OAuth server sits idle, and it adds a
 * `Cf-Access-Jwt-Assertion` for the person to every `/mcp` request it lets
 * through. The gateway verifies that assertion and serves the person
 * (access-caller.ts). The `Authorization` header such a request may also
 * carry holds Access's own opaque token: with a verified assertion it is
 * never looked at; without one it is checked as any bearer and refused.
 *
 * A failure (D1 or KV down, say) answers as each route's callers expect: an
 * error page where a browser is, an OAuth or JSON-RPC error elsewhere.
 */
import { env, waitUntil } from "cloudflare:workers";
import { extractBearerCredential, logEvent } from "@every-app/perimeter";
import { accessConfigFromEnv } from "@/auth/cloudflare-access";
import { verifyOuterRingAssertion } from "@/auth/cloudflare-access/outer-ring";
import { isMcpOauthEnabled, isOauthPath } from "@/server/oauth-flag";
import {
  browserOriginAllowed,
  serveGatewayMcp,
} from "@/server/toolbus/gateway-mcp";
import { resolveAccessCaller } from "./access-caller";
import { errorPage, handleAuthorize, handleConsentDecision } from "./authorize";
import { payloadTooLarge, readBodyWithLimit, withBody } from "./body";
import { getMcpAuth, MCP_OAUTH_PATHS, type McpAuth } from "./config";
import { onPlatformDomain, tokenRequestClientIds } from "./own-domain";
import { normalizeClientRegistrationRequest } from "./registration";
import { allowRegistration } from "./registration-limit";
import { resolvePatCaller } from "./validate";
import { BRAND } from "@/brand";

const MCP_PATH = "/mcp";
/** The header Access adds to every request it lets through. */
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
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
 * `/mcp` through Access: the answer for a request that carries an assertion
 * for the gateway's own Access application, when the outer ring is
 * configured; null for every other request, which is served as it always
 * was (an OAuth token or a personal token in `Authorization`).
 *
 * The header only, never the `CF_Authorization` cookie. Where `/mcp` is
 * bypassed in Access (the setup without Managed OAuth, and the transition
 * to it), a browser's cookie reaches the gateway unverified, and reading it
 * here would let a cross-site POST act as the person; the header is what
 * Access adds to a request it has let through. Behind Managed OAuth, Access
 * lets a cookie-carrying browser request through too, header and all, so
 * what keeps such a browser from driving tool calls is the `Origin` rule
 * the ToolBus applies to every request: it runs here first, before the
 * assertion is verified or anything is read for the person (an origin in
 * MCP_ALLOWED_ORIGINS is trusted with that).
 *
 * An assertion that doesn't verify (forged, on a path Access bypasses) is
 * ignored, and so is a service token's (no email, so verification refuses
 * it): a script can reach `/mcp` through a Service Auth policy with its
 * personal token in `Authorization`, which is then checked as today. One
 * for the apps' application (the other AUD) vouches for nothing on the
 * gateway's host.
 */
async function serveMcpThroughAccess(
  request: Request,
): Promise<Response | null> {
  const { outerRing } = accessConfigFromEnv();
  if (!outerRing) return null;
  // Trimmed as readAccessAssertion trims it, so a blank header can't make
  // it fall back to the cookie.
  if (!request.headers.get(ACCESS_ASSERTION_HEADER)?.trim()) return null;
  if (!browserOriginAllowed(request)) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Forbidden: origin not allowed." },
        id: null,
      },
      { status: 403 },
    );
  }
  const identity = await verifyOuterRingAssertion(request.headers, outerRing);
  if (!identity || !identity.maySignIn) {
    logEvent(
      "mcp.access_assertion_ignored",
      { reason: identity ? "audience" : "invalid" },
      "warn",
    );
    return null;
  }
  return serveGatewayMcp(request, await resolveAccessCaller(identity.email), {
    credentialExpiresAt: identity.claims.exp,
  });
}

async function dispatch(
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const mcpAuth = isMcpOauthEnabled(env) ? getMcpAuth(env) : null;
  if (pathname === MCP_PATH) {
    if (request.method !== "OPTIONS") {
      const served = await serveMcpThroughAccess(request);
      if (served) return served;
    }
    return mcpAuth
      ? mcpAuth.resourceServer.fetch(request, env, requestContext())
      : serveMcpWithTokensOnly(request);
  }
  if (!mcpAuth) return json(404, { error: "oauth_disabled" });

  switch (pathname) {
    case PROTECTED_RESOURCE_METADATA_PATH:
      return mcpAuth.resourceServer.fetch(request, env, requestContext());
    case AUTHORIZATION_SERVER_METADATA_PATH:
      return mcpAuth.authorizationServer.fetch(request, env, requestContext());
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
  mcpAuth: McpAuth,
): Promise<Response> {
  if (request.method !== "POST") {
    return mcpAuth.authorizationServer.fetch(request, env, requestContext());
  }
  const body = await readBodyWithLimit(request, MAX_TOKEN_BODY_BYTES);
  if (!body) return payloadTooLarge("64 KiB");
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
      `${BRAND.name} couldn't finish this just now. Start connecting again from your AI app in a moment.`,
    );
  }
  if (pathname === MCP_PATH) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: `${BRAND.name} is unavailable just now.`,
        },
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
