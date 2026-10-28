/**
 * Production worker entry — the "one door".
 *
 * Every request to this worker is dispatched on Host:
 *  - the gateway's own host (from GATEWAY_URL) → `/health` for uptime
 *    monitors (server/health.ts: public, reads no session), its MCP
 *    connector (`/mcp`) and OAuth authorization server (`/oauth/*`,
 *    discovery), then the
 *    control-plane app (launcher, auth, admin) served by TanStack Start, with
 *    static assets served explicitly via the ASSETS binding
 *    (`run_worker_first` is on so app-host requests can never be answered by
 *    a gateway asset). Its requests pass the control-plane guard and the
 *    credential rate limits first, and every response gets the control-plane
 *    security headers (server/control-plane-guard.ts,
 *    server/auth-rate-limit.ts). The MCP and OAuth code loads with the first
 *    request that needs it (server/mcp-auth/routes.ts), as does the TanStack
 *    Start entry itself (server/control-plane.ts);
 *  - a host in the app registry → the perimeter proxy
 *    (`handleGatewayRequest`), which activates an app whose Worker was just
 *    uploaded and follows the version it runs (server/app-activation.ts),
 *    authenticates the Better Auth session, mints the identity JWT, and
 *    proxies to the app's private worker over its service binding. App
 *    hosts reach this Worker as its Workers Custom Domains.
 *    Where an app's manifest says `mcp: { by: "gateway" }`, its host's
 *    `/mcp` is served by the ToolBus from the app's tool catalog instead
 *    (server/toolbus/app-host-mcp.ts), loaded with the first `/mcp`
 *    request; without the field (every launch app) the host serves no MCP
 *    and the gateway's own `/mcp` is the one connector;
 *  - on a hosted gateway with a third-party domain, a host one label below
 *    it → the same proxy for a third-party (dispatch) app, authenticated by
 *    the host's own session (or a personal access token), never the Better
 *    Auth cookie (perimeter/hostSessionAuthenticator.ts,
 *    server/host-session.ts, loaded with the first such request); the
 *    control plane hands the session off at `/app-session`. Host classes
 *    are decided first (@every-app/perimeter's hostRoutes.ts): a row on the
 *    wrong class of host is never served;
 *  - any other host → 404 (local dev serves the control plane there too).
 *
 * When GATEWAY_URL is not set on a fresh deploy (before secrets, local vite
 * dev), requests fall through to the control plane only while the app registry
 * is empty. Once an active app exists, requests fail closed until the gateway
 * host can be identified again.
 *
 * Two cron triggers (cloudflare.config.ts): every minute, the event bus's
 * delivery sweep retries what is due (server/events/deliver.ts) and the
 * deploy sweep makes every `binding` app live that this gateway reaches
 * (server/app-activation.ts activateDeployingApps: what finishes a deploy
 * behind Cloudflare Access, where no request of the CLI's reaches the
 * gateway); hourly, both sweeps again and then the MCP housekeeping: audit
 * retention, idle connections, the OAuth storage sweep, event retention
 * (server/mcp-auth/maintenance.ts). The hourly one sweeps too so a
 * gateway whose per-minute trigger was never published (an install that
 * predates it) still delivers and still activates.
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
import {
  activateApp,
  activateDeployingApps,
  followAppVersion,
  sweepOnNudge,
} from "./server/app-activation";
import { refuseUnreadyApp } from "./server/app-needs-setup";
import { DrizzleAppRegistry } from "./perimeter/drizzleAppRegistry";
import type { AppCallerProps } from "./server/app-gateway-entrypoint";
import { appBaseDomain, hostProfile } from "./server/app-hosts";
import { rateLimitCredentialRequest } from "./server/auth-rate-limit";
import { serveControlPlane } from "./server/control-plane";
import { HEALTH_PATH, serveHealth } from "./server/health";
import {
  guardControlPlaneRequest,
  withControlPlaneHeaders,
} from "./server/control-plane-guard";
import {
  isMcpOauthEnabled,
  isOauthPath,
  oauthIssuer,
} from "./server/oauth-flag";
import { platformPolicy } from "./server/platform-policy";
import { OrganizationRepository } from "./server/repositories/OrganizationRepository";
import { OrgAppSettingsRepository } from "./server/repositories/OrgAppSettingsRepository";
import { UsageRepository } from "./server/repositories/UsageRepository";

/** The per-minute trigger: the two sweeps alone (cloudflare.config.ts). */
const EVENTS_SWEEP_CRON = "* * * * *";

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

/**
 * An app host's `/mcp`, served by the ToolBus from the app's tool catalog
 * where the manifest asks for it (`mcp: { by: "gateway" }`; the perimeter
 * calls this hook for no other app). The ToolBus loads with the first
 * `/mcp` request on an isolate; a page request on an app host never
 * evaluates it.
 */
const interceptAppHostMcp: NonNullable<GatewayDeps["interceptMcp"]> = async (
  input,
) => (await import("./server/toolbus/app-host-mcp")).serveAppHostMcp(input);

/** The gateway's MCP connector and OAuth paths, served before TanStack. */
function isMcpAuthPath(pathname: string): boolean {
  return (
    pathname === "/mcp" || pathname.startsWith("/mcp/") || isOauthPath(pathname)
  );
}

/**
 * Sign in with Apple's return: a cross-site POST Access can't authenticate
 * (the browser's Access cookie isn't sent on it), so `everyapp access on`
 * leaves it public. Better Auth answers it with a redirect to the same
 * URL as a GET, which is not bypassed, so the sign-in completes behind
 * Access's login; the POST itself reads no session and creates nothing
 * (server/control-plane-guard.ts exempts it from the Origin check for the
 * same reason). Served exact-case to the control plane, before the
 * refusal below, as /health is.
 */
const APPLE_CALLBACK_PATH = "/api/auth/callback/apple";

/**
 * The paths Cloudflare Access lets through without a login
 * (packages/cli/src/lib/access/plan.ts), matched as Access matches them:
 * case-insensitively, `*` spanning segments. The health and MCP/OAuth
 * routes above are exact-case, so what they don't serve under these
 * prefixes (`/HEALTH`, `/MCP`) is a JSON 404 here, never the control
 * plane's shell (docs/threat-model.md, B6).
 */
const ACCESS_BYPASSED_EXACT = [
  HEALTH_PATH,
  "/mcp",
  "/oauth/token",
  "/oauth/register",
  APPLE_CALLBACK_PATH,
];

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
 * The gateway host: `/health` for uptime monitors (before anything else,
 * and before the bypass refusal below, which would otherwise 404 it), its
 * MCP and OAuth routes, the deploy API (only past the launch gate: without
 * it, its paths are the control plane's like any other), the third-party
 * host handoff (only with a third-party domain: without one, its paths are
 * the control plane's too), else the control plane.
 */
async function serveGatewayHost(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === HEALTH_PATH) return serveHealth(request, env.DB);
  if (
    pathname.startsWith("/api/v1/") &&
    platformPolicy(env).thirdPartyDeploys
  ) {
    const { serveDeployApi } = await import("./server/deploy/routes");
    return serveDeployApi(request);
  }
  if (pathname === "/app-session" || pathname === "/app-session/start") {
    const profile = hostProfile(env, ownGatewayHost());
    const { hostSessionKey, serveAppSessionRoute } = await import(
      "./server/host-session"
    );
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
  if (pathname.startsWith("/connect/")) {
    // The Gateway-owned OAuth flow (server/oauth/flow.ts): a signed-in
    // member's connect and the provider's callback, on the session cookie.
    const { serveConnectRoute } = await import("./server/oauth/flow");
    const served = await serveConnectRoute(request);
    if (served) return served;
  }
  if (pathname === APPLE_CALLBACK_PATH) return serveControlPlane(request, env);
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
    // The capability proxy (AI, integrations, email) and its usage
    // accounting load with the first app-to-gateway call on an isolate; a
    // request on an app host never evaluates them.
    const [{ handleAppGatewayRequest }, { gatewayProviders }] =
      await Promise.all([
        import("./server/app-gateway-entrypoint"),
        import("./server/providers"),
      ]);
    return handleAppGatewayRequest({
      request,
      props: this.ctx.props,
      env: this.env,
      registry: new DrizzleAppRegistry(this.env.DB),
      organizations: OrganizationRepository,
      usage: UsageRepository,
      waitUntil: (task) => this.ctx.waitUntil(task),
      caps: {
        effectiveMonthlyCaps: OrgAppSettingsRepository.getEffectiveMonthlyCaps,
        monthlyUsage: UsageRepository.monthlyUsage,
      },
      // The catalog and this gateway's registered providers.
      providers: gatewayProviders,
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
  const { exchangeHostSession, hostSessionKey, startHostSession } =
    await import("./server/host-session");
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
    interceptMcp: interceptAppHostMcp,
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
        interceptMcp: interceptAppHostMcp,
        // "Sign in with Every App": a first-party host names the gateway's
        // OAuth server in its protected-resource metadata while OAuth is
        // on (the same switch MCP clients are under; no new one).
        authorizationServer: isMcpOauthEnabled(env)
          ? (oauthIssuer(env) ?? undefined)
          : undefined,
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

  async scheduled(controller: ScheduledController, runtimeEnv: Cloudflare.Env) {
    // A sweep that fails (a D1 error, a Worker updated ahead of its
    // migration) is logged; the hour's housekeeping still runs.
    try {
      const { sweep } = await import("./server/events/deliver");
      const swept = await sweep();
      if (swept.due > 0) logEvent("events.sweep", swept);
    } catch (error) {
      logEvent(
        "events.sweep_failed",
        { message: error instanceof Error ? error.message : String(error) },
        "error",
      );
    }
    // Never throws: a deploy sweep that fails is logged inside and tried
    // again next minute.
    await activateDeployingApps(
      runtimeEnv,
      () => new DrizzleAppRegistry(runtimeEnv.DB),
    );
    if (controller.cron === EVENTS_SWEEP_CRON) return;
    const { runMcpMaintenance } = await import("./server/mcp-auth/maintenance");
    await runMcpMaintenance(runtimeEnv);
  },

  // The activation queue (`every-app-gateway-activate`): the CLI pushes a
  // message once it has bound an app, and this sweeps every `binding` row
  // now rather than at the next cron (a fresh Gateway's crons take minutes
  // to start). While an app is still binding (an isolate on the previous
  // version, a Worker not reachable yet), the batch is retried in 5 s, up
  // to the queue's retries; the cron stays the fallback. A message's body
  // is never read: it is only a nudge, and pushing one takes the account's
  // own Cloudflare credentials.
  async queue(batch: MessageBatch, runtimeEnv: Cloudflare.Env) {
    await sweepOnNudge(
      batch,
      runtimeEnv,
      () => new DrizzleAppRegistry(runtimeEnv.DB),
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;
