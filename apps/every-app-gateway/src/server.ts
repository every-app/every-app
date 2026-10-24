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
 *    uploaded and follows the version it runs (server/app-activation.ts),
 *    authenticates the Better Auth session, mints the identity JWT, and
 *    proxies to the app's private worker over its service binding. App
 *    hosts reach this Worker as its Workers Custom Domains.
 *    An app host's `/mcp` is served by the ToolBus from the app's tool
 *    catalog instead (server/toolbus/app-host-mcp.ts);
 *  - on a hosted gateway with a third-party domain, a host one label below
 *    it → the same proxy for a third-party (dispatch) app, authenticated by
 *    the host's own session (or a personal access token), never the Better
 *    Auth cookie (perimeter/hostSessionAuthenticator.ts,
 *    server/host-session.ts); the control plane hands the session off at
 *    `/app-session`. Host classes are decided first (@every-app/perimeter's
 *    hostRoutes.ts): a row on the wrong class of host is never served;
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
  hostAdmitsApp,
  HOST_SESSION_PATH,
  logEvent,
  routeHost,
  type AppRegistry,
  type GatewayDeps,
  type RegisteredApp,
  UnroutableAppError,
  unroutableAppResponse,
  withSecurityHeaders,
} from "@every-app/perimeter";
import { SESSION_COOKIE_NAMES } from "./auth/session-cookie";
import { createProdAuthenticator } from "./perimeter/betterAuthAuthenticator";
import { createHostSessionAuthenticator } from "./perimeter/hostSessionAuthenticator";
import { activateApp, followAppVersion } from "./server/app-activation";
import { refuseUnreadyApp } from "./server/app-needs-setup";
import { DrizzleAppRegistry } from "./perimeter/drizzleAppRegistry";
import {
  handleAppGatewayRequest,
  type AppCallerProps,
} from "./server/app-gateway-entrypoint";
import { appBaseDomain, hostProfile } from "./server/app-hosts";
import { rateLimitCredentialRequest } from "./server/auth-rate-limit";
import { serveControlPlane } from "./server/control-plane";
import {
  exchangeHostSession,
  hostSessionKey,
  serveAppSessionRoute,
  startHostSession,
} from "./server/host-session";
import {
  guardControlPlaneRequest,
  withControlPlaneHeaders,
} from "./server/control-plane-guard";
import { isOauthPath } from "./server/oauth-flag";
import { platformPolicy } from "./server/platform-policy";
import { OrganizationRepository } from "./server/repositories/OrganizationRepository";
import { OrgAppSettingsRepository } from "./server/repositories/OrgAppSettingsRepository";
import { UsageRepository } from "./server/repositories/UsageRepository";
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

/**
 * The paths Cloudflare Access lets through without a login
 * (packages/cli/src/lib/access/plan.ts), matched as Access matches them:
 * case-insensitively, `*` spanning segments. The MCP/OAuth router above is
 * exact-case, so what it doesn't serve under these prefixes is a JSON 404
 * here, never the control plane's shell (docs/threat-model.md, B6).
 */
const ACCESS_BYPASSED_EXACT = ["/mcp", "/oauth/token", "/oauth/register"];
const ACCESS_BYPASSED_PREFIXES = ["/mcp/", "/.well-known/"];

function isAccessBypassedPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return (
    ACCESS_BYPASSED_EXACT.includes(lower) ||
    ACCESS_BYPASSED_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/** A bypassed path the gateway doesn't serve: not found, and not cached. */
function refuseBypassedPath(): Response {
  return Response.json(
    { error: "not_found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/**
 * The gateway host: its MCP and OAuth routes, the deploy API (only past
 * the launch gate: without it, its paths are the control plane's like any
 * other), the third-party host handoff (only with a third-party domain:
 * without one, its paths are the control plane's too), else the control
 * plane.
 */
async function serveGatewayHost(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (
    pathname.startsWith("/api/v1/") &&
    platformPolicy(env).thirdPartyDeploys
  ) {
    const { serveDeployApi } = await import("./server/deploy/routes");
    return serveDeployApi(request);
  }
  if (pathname === "/app-session" || pathname === "/app-session/start") {
    const profile = hostProfile(env, ownGatewayHost());
    const key = hostSessionKey(env);
    if (profile.thirdPartyDomain && key) {
      const served = await serveAppSessionRoute(request, {
        profile,
        key: await key,
        registry: new DrizzleAppRegistry(env.DB),
      });
      if (served) return served;
    }
  }
  if (isMcpAuthPath(pathname)) {
    const { serveMcpAuthRoute } = await import("./server/mcp-auth/routes");
    const served = await serveMcpAuthRoute(request);
    if (served) return served;
  }
  if (isAccessBypassedPath(pathname)) return refuseBypassedPath();
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
      organizations: OrganizationRepository,
      usage: UsageRepository,
      waitUntil: (task) => this.ctx.waitUntil(task),
      caps: {
        monthlyCallCap: OrgAppSettingsRepository.getMonthlyCap,
        monthlyCalls: UsageRepository.monthlyCalls,
      },
    });
  }
}

// Dispatched apps' outbound Worker (default-deny egress); no routes.
export { Outbound } from "./server/outbound";

/**
 * A third-party app's host: the handoff's code exchange, else the perimeter
 * with the host's own session. Without the key's secret nothing here can
 * be authenticated, so nothing is served.
 */
async function serveThirdPartyHost(
  request: Request,
  host: string,
  deps: Omit<GatewayDeps, "authenticator">,
  app: RegisteredApp,
): Promise<Response> {
  const keyPromise = hostSessionKey(env);
  if (!keyPromise) return notFound("gateway_misconfigured");
  const key = await keyPromise;
  if (new URL(request.url).pathname === HOST_SESSION_PATH) {
    // No Referer from here: the page the exchange leads to (by redirect or
    // the expired-link page's link) would hand the app the code's URL.
    return withSecurityHeaders(
      await exchangeHostSession(request, { app, host, key }),
      { referrerPolicy: "no-referrer" },
    );
  }
  return handleGatewayRequest(request, {
    ...deps,
    authenticator: createHostSessionAuthenticator({
      app,
      host,
      key,
      tokens: createProdAuthenticator(platformPolicy(env)),
    }),
    interceptMcp: serveAppHostMcp,
    thirdParty: {
      startSession: (navigation) =>
        startHostSession(navigation, host, env.GATEWAY_URL),
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const gatewayHost = ownGatewayHost();
    const requestHost = (request.headers.get("host") ?? "")
      .trim()
      .toLowerCase();
    const route = routeHost(requestHost, hostProfile(env, gatewayHost));

    if (route.kind === "control_plane") {
      return serveGuarded(
        request,
        requestHost || new URL(request.url).host,
        serveGatewayHost,
      );
    }
    if (route.kind === "not_found") {
      return notFound("unknown_app_host");
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
      // An unregistered third-party host: there is nothing else there.
      if (route.kind === "third_party") {
        return notFound("unknown_app_host");
      }
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

    if (!hostAdmitsApp(route, app)) {
      return unroutableAppResponse(
        new UnroutableAppError(
          app.appId,
          `a ${app.tier} app on a ${route.kind} host`,
        ),
      );
    }
    followAppVersion(app);

    const deps = {
      env: env as unknown as Record<string, unknown>,
      registry,
      privateKeyPem: env.JWT_PRIVATE_KEY,
      issuer: env.GATEWAY_URL,
      resolveApp: async () => app,
      activate: async (binding: RegisteredApp) => {
        const active = await activateApp(env, binding);
        // The cached row still says `binding`.
        if (active) hostnameCache.delete(requestHost);
        return active;
      },
      // An app whose required settings aren't set doesn't open, on either
      // class of host (server/app-needs-setup.ts).
      needsSetup: refuseUnreadyApp,
    };
    try {
      if (route.kind === "third_party") {
        return await serveThirdPartyHost(request, requestHost, deps, app);
      }
      return await handleGatewayRequest(request, {
        ...deps,
        authenticator: createProdAuthenticator(platformPolicy(env)),
        loginUrl: `${env.GATEWAY_URL}/sign-in`,
        interceptMcp: serveAppHostMcp,
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
