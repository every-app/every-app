/**
 * An app's public routes, as the Gateway serves them: what everyapp.config.ts
 * declares under `public` is open to anyone on the internet with only the
 * signed public marker, and `deploy` and `access on` let those paths
 * through Cloudflare Access too (lib/access/plan.ts). `deploy` says so at
 * the end of its run and `status` counts them, so an operator sees what
 * the manifest opened. Each route carries the methods the Gateway answers
 * on it: GET alone when the route names none, as the perimeter matches
 * them (perimeter/src/publicRoutes.ts), in manifest order.
 */
import type { PublicRoute } from "@every-app/perimeter/manifest";

/** A public route as `deploy --json` and `status --json` carry it. */
export interface PublicRouteSummary {
  path: string;
  /** Upper-cased; `["GET"]` for a route that names none. */
  methods: string[];
}

/** How many routes the end of a deploy lists before saying how many more. */
const SHOWN_PUBLIC_ROUTES = 6;

/** The routes a manifest declares under `public`, in its order. */
export function publicRoutesOf(
  manifest: { public?: readonly PublicRoute[] | undefined } | null | undefined,
): PublicRouteSummary[] {
  return (manifest?.public ?? []).map((route) => summary(route.path, route.methods));
}

/**
 * The routes a stored manifest (the registry's `apps.manifest`, JSON)
 * declares; none when it can't be read. The manifest was validated when it
 * was stored; what is read back is only shaped, not checked again.
 */
export function storedPublicRoutes(stored: unknown): PublicRouteSummary[] {
  if (typeof stored !== "string") return [];
  try {
    const manifest: unknown = JSON.parse(stored);
    const routes = (manifest as { public?: unknown } | null)?.public;
    if (!Array.isArray(routes)) return [];
    return routes.flatMap((route: unknown) => {
      const path = (route as { path?: unknown } | null)?.path;
      if (typeof path !== "string") return [];
      const methods = (route as { methods?: unknown }).methods;
      return [
        summary(
          path,
          Array.isArray(methods)
            ? methods.filter((method): method is string => typeof method === "string")
            : undefined,
        ),
      ];
    });
  } catch {
    return [];
  }
}

/**
 * The routes as a person reads them: `GET /hooks/*, POST /collect`, a
 * route's methods joined with `/` (`GET/HEAD /uploads/**`), the first
 * `limit` of them; `more` is how many the list leaves out.
 */
export function listPublicRoutes(
  routes: readonly PublicRouteSummary[],
  limit = SHOWN_PUBLIC_ROUTES,
): { shown: string; more: number } {
  return {
    shown: routes
      .slice(0, limit)
      .map((route) => `${route.methods.join("/")} ${route.path}`)
      .join(", "),
    more: Math.max(0, routes.length - limit),
  };
}

function summary(path: string, methods: readonly string[] | undefined): PublicRouteSummary {
  return { path, methods: (methods ?? ["GET"]).map((method) => method.toUpperCase()) };
}
