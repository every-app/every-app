/**
 * Validates and sanitizes a redirect URL to prevent open redirect attacks.
 * Returns "/" if the redirect is invalid or missing.
 */
export function getSafeRedirect(redirect?: string): string {
  return redirect && redirect.startsWith("/") && !redirect.includes("://")
    ? redirect
    : "/";
}
