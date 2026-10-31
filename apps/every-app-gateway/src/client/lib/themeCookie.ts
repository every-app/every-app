// The light/dark pick every app shares. The launcher and each app live on
// their own host (`<app>.<gateway host>`), so localStorage is per surface; a
// cookie on the Gateway host reaches all of them. It is a display choice
// only, so it is readable by script and by every app (not HttpOnly). Apps
// keep a copy of this convention: name, values and domain must match.

export type ThemePreference = "system" | "light" | "dark";

const THEME_COOKIE_NAME = "everyapp-theme";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** The pick in a `document.cookie` string, or null when there is none. */
export function readThemeCookie(cookie: string): ThemePreference | null {
  const match = new RegExp(
    `(?:^|;\\s*)${THEME_COOKIE_NAME}=(system|light|dark)(?:;|$)`,
  ).exec(cookie);
  return match ? (match[1] as ThemePreference) : null;
}

/**
 * The Domain the cookie is set on: the Gateway's hostname, when the page is
 * on it or on one of its subdomains. Null otherwise (an app on a custom
 * hostname, or no Gateway URL): the pick then stays in localStorage.
 */
export function themeCookieDomain(
  pageHostname: string,
  gatewayHostname: string | null | undefined,
): string | null {
  if (!gatewayHostname) return null;
  const page = pageHostname.toLowerCase().replace(/\.$/, "");
  const gateway = gatewayHostname.toLowerCase().replace(/\.$/, "");
  if (page === gateway || page.endsWith(`.${gateway}`)) return gateway;
  return null;
}

/** The `document.cookie` assignment that stores a pick. */
export function themeCookieString(
  themePreference: ThemePreference,
  domain: string,
  secure: boolean,
): string {
  return [
    `${THEME_COOKIE_NAME}=${themePreference}`,
    // A one-label host (`localhost`, `everyapp dev`'s stub mode) gets a
    // host-only cookie: browsers differ on Domain=localhost, and a cookie on
    // localhost already reaches every port. Mirror mode's two-label base host
    // (everyapp.localhost) takes the Domain like a real one.
    ...(domain.includes(".") ? [`Domain=${domain}`] : []),
    "Path=/",
    `Max-Age=${ONE_YEAR_SECONDS}`,
    "SameSite=Lax",
    // http://localhost in development: Safari drops a Secure cookie there.
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Stores the pick on the shared cookie; false when the page can't share it. */
export function writeThemeCookie(
  themePreference: ThemePreference,
  gatewayHostname: string | null | undefined,
): boolean {
  if (typeof document === "undefined") return false;
  const domain = themeCookieDomain(location.hostname, gatewayHostname);
  if (!domain) return false;
  document.cookie = themeCookieString(
    themePreference,
    domain,
    location.protocol === "https:",
  );
  return true;
}

/**
 * The no-flash script's first step, as source: sets `p` to the cookie's pick,
 * or to null. Scripts that run before the bundle can't import, so they inline
 * this.
 */
export const readThemeCookieScript = `var m = /(?:^|;\\s*)${THEME_COOKIE_NAME}=(system|light|dark)(?:;|$)/.exec(document.cookie); var p = m ? m[1] : null;`;
