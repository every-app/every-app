/**
 * Production worker entry — the "one door".
 *
 * Every request to this worker is dispatched on Host:
 *  - the gateway's own host (from GATEWAY_URL) → its MCP connector (`/mcp`)
 *    and OAuth authorization server (`/oauth/*`, discovery), then the
 *    control-plane app (launcher, auth, admin) served by TanStack Start, with
 *    static assets served explicitly via the ASSETS binding
 *    (`run_worker_first` is on so app-host requests can never be answered by
 *    a gateway asset). Its requests pass the control-plane guard and the
 *    credential rate limits first, and every response gets the control-plane
 *    security headers (server/control-plane-guard.ts,
 *    server/auth-rate-limit.ts). The MCP and OAuth code loads with the first
 *    request that needs it (server/mcp-auth/routes.ts);
 *  - a host in the app registry → the perimeter proxy
 *    (`handleGatewayRequest`), which activates an app whose Worker was just
 *    uploaded (server/app-activation.ts), authenticates the Better Auth session,
 *    mints the identity JWT, and proxies to the app's private worker over its
 *    service binding. App hosts reach this Worker as its Workers Custom
 *    Domains.
 *    An app host's `/mcp` is served by the ToolBus from the app's tool
 *    catalog instead (server/toolbus/app-host-mcp.ts);
 *  - any other host → 404 (local dev serves the control plane there too).
 *
 * When GATEWAY_URL is not set on a fresh deploy (before secrets, local vite
 * dev), requests fall through to the control plane only while the app registry
 * is empty. Once an active app exists, requests fail closed until the gateway
 * host can be identified again.
 *
 * The hourly cron trigger runs the MCP housekeeping: audit retention,
 * idle connections, and the OAuth storage sweep (server/mcp-auth/maintenance.ts).
 */
import { env, WorkerEntrypoint } from "cloudflare:workers";
import {
  DUPLICATE_SESSION_COOKIE_MESSAGE,
  handleGatewayRequest,
  hasDuplicateSessionCookie,
  logEvent,
  type AppRegistry,
  type RegisteredApp,
  UnroutableAppError,
  unroutableAppResponse,
  withSecurityHeaders,
} from "@every-app/perimeter";
import { SESSION_COOKIE_NAMES } from "./auth/session-cookie";
import { createProdAuthenticator } from "./perimeter/betterAuthAuthenticator";
import { activateApp } from "./server/app-activation";
import { DrizzleAppRegistry } from "./perimeter/drizzleAppRegistry";
import {
  handleAppGatewayRequest,
  type AppCallerProps,
} from "./server/app-gateway-entrypoint";
import { appBaseDomain } from "./server/app-hosts";
import { rateLimitCredentialRequest } from "./server/auth-rate-limit";
import { serveControlPlane } from "./server/control-plane";
import {
  guardControlPlaneRequest,
  withControlPlaneHeaders,
} from "./server/control-plane-guard";
import { isOauthPath } from "./server/oauth-flag";
import { serveAppHostMcp } from "./server/toolbus/app-host-mcp";

const HOST_CACHE_MAX_ENTRIES = 500;
const HOST_CACHE_HIT_TTL_MS = 30_000;
const HOST_CACHE_MISS_TTL_MS = 5_000;

const hostnameCache = new Map<
  string,
  { app: RegisteredApp | null; expiresAt: number }
>();

function ownGatewayHost(): string | null {
  if (!env.GATEWAY_URL) return null;
  try {
    return new URL(env.GATEWAY_URL).host.toLowerCase();
  } catch {
    return null;
  }
}

export function clearHostnameCacheForTests(): void {
  hostnameCache.clear();
}

export async function resolveAppByHostname(
  registry: AppRegistry,
  hostname: string,
): Promise<RegisteredApp | null> {
  const now = Date.now();
  const cached = hostnameCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    return cached.app;
  }
  if (cached) {
    hostnameCache.delete(hostname);
  }

  const app = await registry.findByHostname(hostname);

  // Per-isolate cache: a re-registered or disabled app can be stale for up to
  // 30s, which is acceptable for the hot path and keeps fresh registrations
  // visible quickly by giving misses a shorter TTL.
  hostnameCache.set(hostname, {
    app,
    expiresAt: now + (app ? HOST_CACHE_HIT_TTL_MS : HOST_CACHE_MISS_TTL_MS),
  });
  if (hostnameCache.size > HOST_CACHE_MAX_ENTRIES) {
    const oldest = hostnameCache.keys().next().value;
    if (oldest) hostnameCache.delete(oldest);
  }

  return app;
}

/** The gateway's MCP connector and OAuth paths, served before TanStack. */
function isMcpAuthPath(pathname: string): boolean {
  return (
    pathname === "/mcp" || pathname.startsWith("/mcp/") || isOauthPath(pathname)
  );
}

/** The gateway host: its MCP and OAuth routes, else the control plane. */
async function serveGatewayHost(request: Request): Promise<Response> {
  if (isMcpAuthPath(new URL(request.url).pathname)) {
    const { serveMcpAuthRoute } = await import("./server/mcp-auth/routes");
    const served = await serveMcpAuthRoute(request);
    if (served) return served;
  }
  return serveControlPlane(request, env);
}

/**
 * A request carrying the session cookie twice: a host sharing the cookie's
 * domain planted a second copy (cookie tossing, see @every-app/perimeter's
 * cookies.ts), so neither copy is read. Logged like the app-host refusal,
 * with where it happened and never the cookie.
 */
function refuseDuplicateSessionCookie(request: Request): Response | null {
  if (!hasDuplicateSessionCookie(request.headers, SESSION_COOKIE_NAMES)) {
    return null;
  }
  const { host, pathname } = new URL(request.url);
  logEvent("session.duplicate_cookie", { host, path: pathname }, "warn");
  return Response.json(
    {
      error: "duplicate_session_cookie",
      message: DUPLICATE_SESSION_COOKIE_MESSAGE,
    },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Serve a control-plane request: refuse a tossed session cookie, guard it,
 * count it against the credential rate limits, then hand it to `serve`,
 * stamping the control-plane security headers on whatever comes back.
 */
async function serveGuarded(
  request: Request,
  host: string,
  serve: (request: Request) => Promise<Response>,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const denied =
    refuseDuplicateSessionCookie(request) ??
    guardControlPlaneRequest(request, host) ??
    (await rateLimitCredentialRequest(request, env));
  if (denied) return withControlPlaneHeaders(denied, pathname);
  return withControlPlaneHeaders(await serve(request), pathname);
}

function notFound(error: string): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify({ error }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** Private app-to-gateway surface, reachable only through a named binding. */
export class AppGateway extends WorkerEntrypoint<
  Cloudflare.Env,
  AppCallerProps
> {
  async fetch(request: Request): Promise<Response> {
    return handleAppGatewayRequest({
      request,
      props: this.ctx.props,
      env: this.env,
      registry: new DrizzleAppRegistry(this.env.DB),
    });
  }
}

// Dispatched apps' outbound Worker (default-deny egress); no routes.
export { Outbound } from "./server/outbound";

export default {
  async fetch(request: Request): Promise<Response> {
    const gatewayHost = ownGatewayHost();
    const requestHost = (request.headers.get("host") ?? "")
      .trim()
      .toLowerCase();

    if (!requestHost || requestHost === gatewayHost) {
      return serveGuarded(
        request,
        requestHost || new URL(request.url).host,
        serveGatewayHost,
      );
    }

    const registry = new DrizzleAppRegistry(env.DB);

    if (!gatewayHost) {
      // Without GATEWAY_URL we cannot distinguish the control-plane host from
      // an app-shaped host. Preserve fresh-deploy bootstrap only while no
      // active apps exist; afterward, fail closed so the shared session cookie
      // is never exposed to the control-plane UI on an app origin.
      //
      // A thrown registry query means the DB has no schema — build-time
      // prerender (unmigrated local D1) or a brand-new deploy — which is the
      // bootstrap case, not a populated gateway; serve the control plane. A
      // migrated DB answers cleanly, so the fail-closed path above is
      // unaffected at runtime.
      let hasActiveApp = false;
      try {
        hasActiveApp = await registry.hasAnyActiveApp();
      } catch {
        hasActiveApp = false;
      }
      if (hasActiveApp) {
        return notFound("gateway_misconfigured");
      }
      return serveGuarded(request, requestHost, (guarded) =>
        serveControlPlane(guarded, env),
      );
    }

    // A host other than the gateway's own is an app host — if it's in the
    // registry. A failed lookup (unmigrated D1, brand-new deploy) is treated
    // as no app, so app content is never served on a failure; a row the
    // gateway can't route (an unknown tier or scope) is a 503.
    let app: RegisteredApp | null = null;
    try {
      app = await resolveAppByHostname(registry, requestHost);
    } catch (error) {
      if (error instanceof UnroutableAppError) {
        return unroutableAppResponse(error);
      }
      app = null;
    }
    if (!app) {
      // Below the gateway's own host or the app base domain, an unregistered
      // subdomain is a 404 — serving the control plane (auth/admin UI) on an
      // arbitrary app-shaped origin would let a stale origin or service
      // worker impersonate it, and the session cookie spans these hosts.
      const base = appBaseDomain(env);
      if (
        requestHost.endsWith(`.${gatewayHost}`) ||
        (base && requestHost.endsWith(`.${base}`))
      ) {
        return notFound("unknown_app_host");
      }
      // A deployed gateway serves its control plane on its own host only:
      // stray aliases, the workers.dev host and leftover routes get a 404.
      // Local dev (`vite dev`, Docker self-host) keeps serving it on other
      // hosts, such as mirror-mode `everyapp dev` calling the gateway on
      // localhost while GATEWAY_URL names the host the browser uses.
      if (!import.meta.env.DEV) {
        return notFound("unknown_host");
      }
      return serveGuarded(request, requestHost, (guarded) =>
        serveControlPlane(guarded, env),
      );
    }

    try {
      return await handleGatewayRequest(request, {
        env: env as unknown as Record<string, unknown>,
        registry,
        authenticator: createProdAuthenticator(),
        privateKeyPem: env.JWT_PRIVATE_KEY,
        issuer: env.GATEWAY_URL,
        resolveApp: async () => app,
        loginUrl: `${env.GATEWAY_URL}/sign-in`,
        interceptMcp: serveAppHostMcp,
        activate: async (binding) => {
          const active = await activateApp(env, binding);
          // The cached row still says `binding`.
          if (active) hostnameCache.delete(requestHost);
          return active;
        },
      });
    } catch (error) {
      // The perimeter must never leak an uncaught exception (Cloudflare's
      // 1101 page) for app-subdomain traffic.
      console.error(
        `perimeter error for ${requestHost}:`,
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      return withSecurityHeaders(
        new Response(JSON.stringify({ error: "gateway_error" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
      );
    }
  },

  async scheduled(
    _controller: ScheduledController,
    runtimeEnv: Cloudflare.Env,
  ) {
    const { runMcpMaintenance } = await import("./server/mcp-auth/maintenance");
    await runMcpMaintenance(runtimeEnv);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
