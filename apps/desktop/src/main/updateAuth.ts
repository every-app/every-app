// The update feed can be private, behind the Gateway on the Scribe app itself
// (https://scribe.<base>/api/v1/updates/mac/, or talk.<base> where it's signed in there). electron-updater then needs the same bearer as the
// API. It's sent only when the feed is on the signed-in app's own origin, so a token never goes to
// another host. No Electron import (tested).

/** The `url:` of electron-builder's app-update.yml (generic provider). */
export function feedUrlFrom(appUpdateYml: string): string | undefined {
  const m = /^url:\s*['"]?([^'"\s#]+)['"]?\s*$/m.exec(appUpdateYml);
  return m?.[1];
}

export function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === "https:" && x.origin === y.origin;
  } catch {
    return false;
  }
}

/** What to do before a check: skip it (signed out, for a private feed), or send these headers. */
export function updateRequest(feedUrl: string | undefined, appUrl: string | undefined, token: string | undefined): { skip: true } | { skip: false; headers: Record<string, string> | null } {
  if (!sameOrigin(feedUrl, appUrl)) return { skip: false, headers: null }; // a public feed: no credentials
  if (!token) return { skip: true };
  return { skip: false, headers: { Authorization: `Bearer ${token}` } };
}
