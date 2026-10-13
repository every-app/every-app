/**
 * Validates and sanitizes a redirect URL to prevent open redirect attacks.
 * Returns "/" if the redirect is invalid or missing.
 */
export function getSafeRedirect(redirect?: string): string {
  return redirect &&
    redirect.startsWith("/") &&
    redirect[1] !== "/" &&
    redirect[1] !== "\\" &&
    !redirect.includes("://")
    ? redirect
    : "/";
}

/**
 * Validates a cross-origin return URL from the perimeter's login redirect
 * (`/sign-in?return_to=<app url>`). Apps live at subdomains of the gateway
 * host, so only http(s) URLs on a subdomain of the current host are allowed —
 * anything else would be an open redirect.
 *
 * The gateway's own host is rejected too: in-gateway destinations use the
 * `redirect` path instead, and the CSRF check on server functions lets
 * same-origin navigations through, so a gateway return_to must never be able
 * to reach one. Server-function URLs are rejected on any host for the same
 * reason.
 *
 * `currentHost` is injectable for tests; defaults to the browser location.
 */
export function getSafeReturnTo(
  returnTo: string | undefined | null,
  currentHost?: string,
): string | null {
  if (!returnTo) return null;
  const host =
    currentHost ??
    (typeof window !== "undefined" ? window.location.host : null);
  if (!host) return null;

  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;

  if (url.pathname === "/_serverFn" || url.pathname.startsWith("/_serverFn/")) {
    return null;
  }

  const target = url.host.toLowerCase();
  const own = host.toLowerCase();
  if (target.endsWith(`.${own}`)) {
    return url.toString();
  }
  return null;
}
