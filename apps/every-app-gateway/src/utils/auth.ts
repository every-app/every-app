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
 * host, so only http(s) URLs on the current host or a subdomain of it are
 * allowed — anything else would be an open redirect.
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

  const target = url.host.toLowerCase();
  const own = host.toLowerCase();
  if (target === own || target.endsWith(`.${own}`)) {
    return url.toString();
  }
  return null;
}
