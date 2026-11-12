import * as React from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  readThemeCookie,
  readThemeCookieScript,
  type ThemePreference,
  writeThemeCookie,
} from "@/client/lib/themeCookie";

export type { ThemePreference };

const LIGHT_THEME_NAME = "openseo";
const DARK_THEME_NAME = "openseo-dark";

const THEME_STORAGE_KEY = "theme-preference";
const THEME_CHANGE_EVENT = "theme-preference-change";

// Set when localStorage cannot store a pick (private browsing, strict modes,
// a full quota): the pick then holds for this page session and wins over
// whatever localStorage still returns.
let unsavedThemePreference: ThemePreference | null = null;

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }
  if (unsavedThemePreference) {
    return unsavedThemePreference;
  }

  // The shared cookie first: a pick made in the launcher or any app counts.
  const shared = readThemeCookie(document.cookie);
  if (shared) {
    return shared;
  }
  return readStoredThemePreference();
}

function readStoredThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
    return "system";
  } catch {
    return "system";
  }
}

/**
 * The Gateway's hostname, from GATEWAY_URL on the server (the root route's
 * loader). Null without one: the pick then stays in localStorage.
 */
function useGatewayHostname(): string | null {
  const gatewayUrl = useRouterState({
    select: (state) => {
      const root = state.matches[0]?.loaderData;
      return root && "gatewayUrl" in root ? root.gatewayUrl : null;
    },
  });
  if (!gatewayUrl) return null;
  try {
    return new URL(gatewayUrl).hostname;
  } catch {
    return null;
  }
}

/** Copies a pick saved before the shared cookie existed into it, once. */
function migrateStoredThemePreference(gatewayHostname: string | null) {
  if (!gatewayHostname || readThemeCookie(document.cookie)) {
    return;
  }
  const stored = readStoredThemePreference();
  if (stored !== "system") {
    writeThemeCookie(stored, gatewayHostname);
  }
}

function writeThemePreference(
  themePreference: ThemePreference,
  gatewayHostname: string | null,
) {
  writeThemeCookie(themePreference, gatewayHostname);
  try {
    if (themePreference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    }
    unsavedThemePreference = null;
  } catch {
    unsavedThemePreference = themePreference;
  }
}

function resolveThemeName(themePreference: ThemePreference): string {
  if (themePreference === "light") return LIGHT_THEME_NAME;
  if (themePreference === "dark") return DARK_THEME_NAME;

  // "system" — resolve from OS preference
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return DARK_THEME_NAME;
  }
  return LIGHT_THEME_NAME;
}

function applyThemePreference(themePreference: ThemePreference) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute(
    "data-theme",
    resolveThemeName(themePreference),
  );
}

function subscribeToThemePreference(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleThemeChange = () => {
    onStoreChange();
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key !== THEME_STORAGE_KEY) {
      return;
    }

    onStoreChange();
  };

  // A pick made in another app's tab only reaches this one through the
  // cookie, which fires no event: read it again when the tab comes back.
  const handleVisibility = () => {
    if (document.visibilityState === "visible") {
      onStoreChange();
    }
  };

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleMediaChange = () => {
    // Re-apply when OS preference changes so "system" mode stays in sync
    applyThemePreference(readThemePreference());
    onStoreChange();
  };

  window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  window.addEventListener("storage", handleStorage);
  document.addEventListener("visibilitychange", handleVisibility);
  mediaQuery.addEventListener("change", handleMediaChange);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    window.removeEventListener("storage", handleStorage);
    document.removeEventListener("visibilitychange", handleVisibility);
    mediaQuery.removeEventListener("change", handleMediaChange);
  };
}

export function useThemePreference() {
  const themePreference = React.useSyncExternalStore<ThemePreference>(
    subscribeToThemePreference,
    readThemePreference,
    () => "system",
  );
  const gatewayHostname = useGatewayHostname();

  React.useEffect(() => {
    migrateStoredThemePreference(gatewayHostname);
  }, [gatewayHostname]);

  React.useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  const setThemePreference = React.useCallback(
    (nextThemePreference: ThemePreference) => {
      writeThemePreference(nextThemePreference, gatewayHostname);
      applyThemePreference(nextThemePreference);
      window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    },
    [gatewayHostname],
  );

  return { themePreference, setThemePreference };
}

export const themePreferenceInitScript = `(() => {
  try {
    ${readThemeCookieScript}
    if (!p) p = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var t;
    if (p === "light") t = ${JSON.stringify(LIGHT_THEME_NAME)};
    else if (p === "dark") t = ${JSON.stringify(DARK_THEME_NAME)};
    else t = window.matchMedia("(prefers-color-scheme: dark)").matches ? ${JSON.stringify(DARK_THEME_NAME)} : ${JSON.stringify(LIGHT_THEME_NAME)};
    document.documentElement.setAttribute("data-theme", t);
  } catch {
    document.documentElement.setAttribute("data-theme", ${JSON.stringify(LIGHT_THEME_NAME)});
  }
})();`;
