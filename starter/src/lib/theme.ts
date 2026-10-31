import { useCallback, useEffect, useSyncExternalStore } from "react";

// Light, dark or system, shared with the launcher and every other app. Each
// app has its own host (`<app>.<gateway host>`), so localStorage is per app;
// the `everyapp-theme` cookie on the Gateway host reaches all of them. Keep
// its name, values and domain as they are: the other apps read the same one.

export type ThemePreference = "system" | "light" | "dark";

const COOKIE = "everyapp-theme";
const STORAGE_KEY = "theme";
const CHANGE_EVENT = "theme-change";
const COOKIE_PATTERN = new RegExp(
  `(?:^|;\\s*)${COOKIE}=(system|light|dark)(?:;|$)`,
);

/** The cookie, then this app's own copy, then the OS. */
function readThemePreference(): ThemePreference {
  const shared = COOKIE_PATTERN.exec(document.cookie)?.[1];
  if (shared) return shared as ThemePreference;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage blocked: fall through to the OS.
  }
  return "system";
}

/**
 * Sets the cookie on the Gateway host when this page is on it or under it.
 * An app on a custom hostname can't share it, and keeps localStorage only.
 */
function writeThemeCookie(pick: ThemePreference, gatewayUrl: string) {
  const gateway = new URL(gatewayUrl).hostname;
  const page = location.hostname;
  if (page !== gateway && !page.endsWith(`.${gateway}`)) return;
  document.cookie = [
    `${COOKIE}=${pick}`,
    // `localhost` gets a host-only cookie, which reaches every port.
    ...(gateway.includes(".") ? [`Domain=${gateway}`] : []),
    "Path=/",
    "Max-Age=31536000",
    "SameSite=Lax",
    ...(location.protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function applyTheme(pick: ThemePreference) {
  const dark =
    pick === "dark" ||
    (pick === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function subscribe(onChange: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  // A pick made in another app's tab fires no event here: read the cookie
  // again when this tab comes back.
  const onVisible = () => document.visibilityState === "visible" && onChange();
  window.addEventListener(CHANGE_EVENT, onChange);
  document.addEventListener("visibilitychange", onVisible);
  media.addEventListener("change", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    document.removeEventListener("visibilitychange", onVisible);
    media.removeEventListener("change", onChange);
  };
}

/** The pick and its setter. `gatewayUrl` is `gatewayUrl(env)`, from the server. */
export function useThemePreference(gatewayUrl: string) {
  const pick = useSyncExternalStore(
    subscribe,
    readThemePreference,
    () => "system" as const,
  );

  useEffect(() => applyTheme(pick), [pick]);

  // A pick saved here before the cookie existed joins the cookie, once.
  useEffect(() => {
    if (!COOKIE_PATTERN.test(document.cookie)) {
      const own = readThemePreference();
      if (own !== "system") writeThemeCookie(own, gatewayUrl);
    }
  }, [gatewayUrl]);

  const setPick = useCallback(
    (next: ThemePreference) => {
      writeThemeCookie(next, gatewayUrl);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage blocked: the cookie, if any, still holds it.
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [gatewayUrl],
  );

  return [pick, setPick] as const;
}

/** Runs before the first paint, so a dark pick never flashes light. */
export const themeInitScript = `(() => {
  try {
    var m = ${COOKIE_PATTERN.toString()}.exec(document.cookie);
    var p = m ? m[1] : localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    var dark = p === "dark" || (p !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {}
})();`;
