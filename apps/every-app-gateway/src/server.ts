/**
 * Production worker entry — the "one door".
 *
 * Every request to this worker is dispatched on Host:
 *  - the gateway's own host (from GATEWAY_URL) → the control-plane app
 *    (launcher, auth, admin) served by TanStack Start, with static assets
 *    served explicitly via the ASSETS binding (`run_worker_first` is on so
 *    app-subdomain requests can never be answered by a gateway asset);
 *  - any other host → the perimeter proxy (`handleGatewayRequest`), which
 *    resolves the app from the D1 registry by full hostname, authenticates the
 *    Better Auth session, mints the identity JWT, and proxies to the app's
 *    private worker over its service binding.
 *
 * When GATEWAY_URL is not set on a fresh deploy (before secrets, local vite
 * dev), requests fall through to the control plane only while the app registry
 * is empty. Once an active app exists, requests fail closed until the gateway
 * host can be identified again.
 */
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { env, WorkerEntrypoint } from "cloudflare:workers";
import {
  handleGatewayRequest,
  type AppRegistry,
  type RegisteredApp,
  withSecurityHeaders,
} from "@every-app/perimeter";
import { createProdAuthenticator } from "./perimeter/betterAuthAuthenticator";
import { DrizzleAppRegistry } from "./perimeter/drizzleAppRegistry";
import {
  handleAppGatewayRequest,
  type AppCallerProps,
} from "./server/app-gateway-entrypoint";
import { serveControlPlane } from "./server/control-plane";
import {
  getOauthProvider,
  syntheticExecutionContext,
} from "./server/oauth-provider";

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

export default createServerEntry({
  async fetch(request) {
    const gatewayHost = ownGatewayHost();
    const requestHost = (request.headers.get("host") ?? "")
      .trim()
      .toLowerCase();

    if (!requestHost || requestHost === gatewayHost) {
      return getOauthProvider().fetch(
        request,
        env,
        syntheticExecutionContext(),
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
        return withSecurityHeaders(
          new Response(JSON.stringify({ error: "gateway_misconfigured" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return serveControlPlane(request, env);
    }

    // A host other than the gateway's own is an app subdomain — if it's in
    // the registry. A failed lookup (unmigrated D1 during build-time
    // prerender, brand-new deploy) is treated as no app: within the wildcard
    // that 404s and elsewhere it serves the control plane, so app content is
    // never served on a failure.
    let app: RegisteredApp | null = null;
    try {
      app = await resolveAppByHostname(registry, requestHost);
    } catch {
      app = null;
    }
    if (!app) {
      // Inside the gateway's own wildcard namespace, an unregistered
      // subdomain is a 404 — serving the control plane (auth/admin UI) on an
      // arbitrary app-shaped origin would let a stale origin or service
      // worker impersonate it, and the session cookie spans these hosts.
      if (requestHost.endsWith(`.${gatewayHost}`)) {
        return withSecurityHeaders(
          new Response(JSON.stringify({ error: "unknown_app_host" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      // Hosts unrelated to the gateway domain (build-time prerender, stray
      // aliases) fall through to the control plane, which never serves app
      // content.
      return serveControlPlane(request, env);
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
});
