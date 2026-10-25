/**
 * An app's public surface, as the Gateway serves it: what everyapp.config.ts
 * declares under `public` is open to anyone on the internet with only the
 * signed public marker, and a manifest that sets `mcp: { by, why }` has
 * its host answer `/mcp` to MCP clients with a token of their own;
 * `deploy` and `access on` let those paths through Cloudflare Access too
 * (lib/access/plan.ts). `deploy` says so at the end of its run and
 * `status` lists them, so an operator sees what the manifest opened. Each
 * route carries the methods the Gateway answers on it: GET alone when the
 * route names none, as the perimeter matches them
 * (perimeter/src/publicRoutes.ts), in manifest order.
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

/** A manifest's `mcp` as `deploy --json` and `status --json` carry it. */
export interface McpSummary {
  /** Who answers `/mcp` on the app's host: the Gateway's ToolBus, or the app's own server. */
  by: "gateway" | "app";
  /** Why the app needs `/mcp` on its own host, as the manifest says it. */
  why: string;
}

/** The manifest's `mcp`, when it sets one. */
export function mcpOf(manifest: { mcp?: McpSummary | undefined } | null | undefined): McpSummary | null {
  return manifest?.mcp ? { by: manifest.mcp.by, why: manifest.mcp.why } : null;
}

/**
 * A stored manifest's `mcp` (the registry's `apps.manifest`, JSON), or
 * null when it sets none or can't be read. Shaped, not validated, like
 * `storedPublicRoutes`: the old string form (`mcp: "gateway"`, which no
 * deployed manifest carries) reads as none.
 */
export function storedMcp(stored: unknown): McpSummary | null {
  if (typeof stored !== "string") return null;
  try {
    const manifest: unknown = JSON.parse(stored);
    const mcp = (manifest as { mcp?: unknown } | null)?.mcp;
    if (!mcp || typeof mcp !== "object") return null;
    const { by, why } = mcp as { by?: unknown; why?: unknown };
    if ((by !== "gateway" && by !== "app") || typeof why !== "string") return null;
    return { by, why };
  } catch {
    return null;
  }
}

/** `/mcp` as the PUBLIC column and the end of a deploy say it: who answers it on the app's host. */
export const describeMcp = (mcp: McpSummary): string => `MCP /mcp (${mcp.by})`;

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
