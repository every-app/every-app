/**
 * Cookie tossing.
 *
 * The session cookie is scoped to a domain the gateway shares with every app
 * host, and any host under the same registrable domain (a sibling subdomain,
 * or an app answering on its own host) can plant a cookie of the same name,
 * scoped to the parent domain or to a longer path. The browser then sends
 * both, in an order the planting host chooses (longer paths first), and
 * whichever one the session parser keeps decides whose session the request
 * runs as: the victim's browser could act as the attacker's account (a login
 * CSRF), or the attacker could pin which copy is read. No legitimate browser
 * holds two copies of the session cookie, so a request naming one more than
 * once is refused before anything reads it.
 */

/**
 * What a refused request is told, on the gateway host and on app hosts
 * alike: the copy a sibling host planted lives in the browser until the
 * person clears it.
 */
export const DUPLICATE_SESSION_COOKIE_MESSAGE =
  "Your browser sent more than one EveryApp session cookie, which another site on this domain can cause. Clear this site's cookies and sign in again.";

/**
 * How many times the Cookie header names any of `names`. A request may carry
 * several Cookie headers, which `Headers` joins with ", ", so commas count as
 * separators too: splitting more finely only ever finds more copies.
 */
function countCookies(headers: Headers, names: readonly string[]): number {
  const header = headers.get("cookie");
  if (!header) return 0;
  let count = 0;
  for (const pair of header.split(/[;,]/)) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (names.includes(pair.slice(0, equals).trim())) count++;
  }
  return count;
}

/**
 * Whether the request carries the session cookie at all, under any of its
 * names: what a bearer route refuses (gateway.ts), so an Access bypass for
 * bearer clients never serves a browser's ambient credential.
 */
export function hasSessionCookie(
  headers: Headers,
  names: readonly string[],
): boolean {
  return names.length > 0 && countCookies(headers, names) > 0;
}

/**
 * Whether the request carries the session cookie more than once, counting
 * every name it goes by (with or without the `__Secure-` prefix) together.
 */
export function hasDuplicateSessionCookie(
  headers: Headers,
  names: readonly string[],
): boolean {
  return names.length > 0 && countCookies(headers, names) > 1;
}
