/**
 * Request guard and response headers for the gateway's own host.
 *
 * The control plane is reachable with the same session cookie as every app
 * subdomain, so a page on any app is "same-site" and the browser attaches the
 * cookie to requests it forges. TanStack Start's CSRF middleware (src/start.ts)
 * and Better Auth's origin check each cover part of this; the guard here runs
 * before both, in the worker entry, so it holds whatever the framework does:
 *
 *  - `/_serverFn/*` answers only same-origin fetch() calls from TanStack's
 *    client (same rule the perimeter applies on app hosts);
 *  - a cookie-carrying state-changing request must pass the perimeter's
 *    Origin / Sec-Fetch-Site check. Cookieless requests carry no session to
 *    ride, and token-authenticated routes (deploy API, OAuth token and
 *    registration endpoints) are left to their own bearer checks.
 */
import {
  evaluateCsrf,
  evaluateServerFnRequest,
  isServerFnPath,
  withSecurityHeaders,
} from "@every-app/perimeter";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Called by programmatic clients with their own credentials, never by a
// gateway page.
const TOKEN_AUTHENTICATED_PATHS = ["/oauth/token", "/oauth/register"];
const TOKEN_AUTHENTICATED_PREFIXES = ["/api/deploy/", "/oauth/userinfo"];

// The native shell's auth client sends this exact app origin (as Origin or
// expo-origin) and no Fetch Metadata. A browser can do neither, and Better
// Auth checks it against trustedOrigins behind this guard.
const NATIVE_APP_ORIGIN = "everyapp://";

// Pages that show secrets, consent or setup state: never cached.
const NO_STORE_PATHS = [
  "/admin",
  "/oauth/authorize",
  "/setup",
  "/reset-password",
];

function isTokenAuthenticatedPath(pathname: string): boolean {
  return (
    TOKEN_AUTHENTICATED_PATHS.includes(pathname) ||
    TOKEN_AUTHENTICATED_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(prefix),
    )
  );
}

function isNativeAppAuthRequest(request: Request, pathname: string): boolean {
  if (!pathname.startsWith("/api/auth/")) return false;
  if (request.headers.has("sec-fetch-site")) return false;
  const origin =
    request.headers.get("origin") ?? request.headers.get("expo-origin");
  return origin?.toLowerCase() === NATIVE_APP_ORIGIN;
}

function forbidden(error: string, reason: string): Response {
  return new Response(JSON.stringify({ error, reason }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Returns a 403 for a request the control plane must not serve, or null to
 * let it through. `host` is the gateway host the request arrived on.
 */
export function guardControlPlaneRequest(
  request: Request,
  host: string,
): Response | null {
  const { pathname } = new URL(request.url);

  if (isServerFnPath(pathname)) {
    const decision = evaluateServerFnRequest(request.headers);
    if (!decision.allowed) {
      return forbidden("server_fn_denied", decision.reason);
    }
  }

  if (
    SAFE_METHODS.has(request.method.toUpperCase()) ||
    !request.headers.has("cookie") ||
    isTokenAuthenticatedPath(pathname) ||
    isNativeAppAuthRequest(request, pathname)
  ) {
    return null;
  }

  const csrf = evaluateCsrf(
    request.method,
    host,
    request.headers.get("origin"),
    request.headers.get("sec-fetch-site"),
  );
  return csrf.allowed ? null : forbidden("csrf_denied", csrf.reason);
}

function isNoStorePath(pathname: string): boolean {
  return NO_STORE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * Security headers for every control-plane response: HSTS for this host
 * only, nosniff, no framing (X-Frame-Options and CSP frame-ancestors on
 * HTML), no Referer (so invitation and reset links never leak to other
 * sites), and no-store on admin, consent and setup pages. Unlike app
 * responses, the session cookie's Domain is kept: it must span the app
 * subdomains.
 */
export function withControlPlaneHeaders(
  response: Response,
  pathname: string,
): Response {
  return withSecurityHeaders(response, {
    // No includeSubDomains or preload: the gateway often runs on the
    // customer's apex domain, whose other subdomains are not ours to pin
    // to HTTPS. App hosts send their own HSTS.
    hsts: "max-age=63072000",
    referrerPolicy: "no-referrer",
    stripCookieDomains: false,
    noStore: isNoStorePath(pathname),
  });
}
