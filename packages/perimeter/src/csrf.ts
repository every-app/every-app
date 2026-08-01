/**
 * CSRF defense at the perimeter.
 *
 * The shared parent-domain session cookie means a forged cross-site POST would
 * otherwise ride the user's session. We default-deny any state-changing request
 * (non-GET/HEAD/OPTIONS) whose origin signals are absent or inconsistent with
 * the app's own subdomain. The WebView mobile shell behaves like a browser, so
 * it needs no special path.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CsrfDecision {
  allowed: boolean;
  reason: string;
}

/**
 * @param method   HTTP method
 * @param expectedHost  the app's own host (e.g. `todo.example.com`) — the only
 *                      origin permitted to make state-changing requests.
 * @param origin   the `Origin` request header (may be null)
 * @param secFetchSite  the `Sec-Fetch-Site` request header (may be null)
 */
export function evaluateCsrf(
  method: string,
  expectedHost: string,
  origin: string | null,
  secFetchSite: string | null,
): CsrfDecision {
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return { allowed: true, reason: "safe method" };
  }

  // Sec-Fetch-Site is the strongest signal where present. `same-origin` is the
  // only value we accept outright; `none` (user-initiated, e.g. bookmark) is
  // implausible for a non-GET app request, and cross-site is always rejected.
  if (secFetchSite !== null) {
    if (secFetchSite === "same-origin") {
      return { allowed: true, reason: "sec-fetch-site same-origin" };
    }
    return {
      allowed: false,
      reason: `sec-fetch-site ${secFetchSite}`,
    };
  }

  // Fall back to Origin. Default-deny when absent (can't prove same-origin).
  if (origin === null) {
    return { allowed: false, reason: "no origin and no sec-fetch-site" };
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { allowed: false, reason: "malformed origin" };
  }
  if (originHost === expectedHost) {
    return { allowed: true, reason: "origin matches app host" };
  }
  return {
    allowed: false,
    reason: `origin ${originHost} != ${expectedHost}`,
  };
}
