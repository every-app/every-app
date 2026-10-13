/**
 * Request guard for TanStack Start server functions.
 *
 * Server functions are cookie-authenticated RPC endpoints under one path
 * prefix. The session cookie spans every app subdomain, so every sibling app
 * is "same-site", and TanStack Start runs a GET server function for any GET
 * that carries `?payload=`. Without this guard a link, redirect or `<img>` on
 * any app page could invoke a server function with the member's identity, and
 * a top-level navigation could render a server-function response as a page
 * (the reflected XSS in CVE-2026-102989, for apps still on an affected build).
 *
 * Real clients only ever call server functions with fetch() from the app's
 * own origin, and always send a TanStack header: `x-tsr-serverFn: true`
 * (1.168+ clients) or `x-tsr-redirect: manual` (1.140-era clients). A
 * cross-origin page cannot add a custom header without a CORS preflight the
 * app never grants, so requiring one blocks forged calls on every method.
 */
import type { CsrfDecision } from "./csrf";

// TanStack Start's default. An app with a router basepath or its own
// `serverFns.base` declares where its server functions live instead
// (manifest `serverFnBase`).
const DEFAULT_SERVER_FN_BASE = "/_serverFn";

/**
 * Decode a path the way TanStack Start (1.168+) does before routing: all at
 * once, or, when it holds a malformed escape (`%ZZ`, a lone `%E0`), each
 * valid `%XX` on its own. Matching the raw form instead would let
 * `/%5FserverFn/<id>/%ZZ` reach the server-function handler unguarded.
 */
function decodePath(rawPathname: string): string {
  try {
    return decodeURIComponent(rawPathname);
  } catch {
    return rawPathname.replace(/%[0-9a-f]{2}/gi, (escape) => {
      try {
        return decodeURIComponent(escape);
      } catch {
        return escape;
      }
    });
  }
}

/**
 * Whether TanStack Start would route this path to its server-function
 * handler at `base`. Start decodes the path and resolves dot segments and
 * leading slashes before matching, so this does the same rather than
 * trusting the raw form (`/%5FserverFn/…` and `/x/%2e%2e/_serverFn/…` both
 * reach it).
 */
export function isServerFnPath(
  rawPathname: string,
  base: string = DEFAULT_SERVER_FN_BASE,
): boolean {
  const decoded = decodePath(rawPathname);
  let resolved: string;
  try {
    resolved = new URL(decoded.replace(/^[/\\]+/, "/"), "https://x.invalid")
      .pathname;
  } catch {
    resolved = decoded;
  }
  const path = resolved.toLowerCase();
  const prefix = base.toLowerCase().replace(/\/+$/, "");
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isNavigation(headers: Headers): boolean {
  const mode = headers.get("sec-fetch-mode");
  const dest = headers.get("sec-fetch-dest");
  if (mode === "navigate" || mode === "nested-navigate") return true;
  if (dest === "document" || dest === "iframe" || dest === "frame") {
    return true;
  }
  // Without Fetch Metadata (older browsers, some WebViews), an HTML Accept
  // is the tell: TanStack's fetcher only ever asks for JSON or its framed
  // stream format.
  const hasFetchMetadata =
    mode !== null || headers.get("sec-fetch-site") !== null;
  return (
    !hasFetchMetadata &&
    (headers.get("accept") ?? "").toLowerCase().includes("text/html")
  );
}

function hasTanStackClientHeader(headers: Headers): boolean {
  return (
    headers.get("x-tsr-serverfn")?.trim().toLowerCase() === "true" ||
    headers.get("x-tsr-redirect")?.trim().toLowerCase() === "manual"
  );
}

/** Decide whether a request to a server-function path may reach the app. */
export function evaluateServerFnRequest(headers: Headers): CsrfDecision {
  if (isNavigation(headers)) {
    return { allowed: false, reason: "server function navigation" };
  }

  const secFetchSite = headers.get("sec-fetch-site");
  if (secFetchSite !== null && secFetchSite !== "same-origin") {
    return { allowed: false, reason: `sec-fetch-site ${secFetchSite}` };
  }

  if (!hasTanStackClientHeader(headers)) {
    return { allowed: false, reason: "missing server function client header" };
  }

  return { allowed: true, reason: "same-origin server function call" };
}
