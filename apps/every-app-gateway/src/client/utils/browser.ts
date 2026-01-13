/**
 * Detects if the current browser is Safari.
 * Safari is the only major browser that blocks http:// iframes from https:// pages.
 */
export function isSafari(): boolean {
  const ua = navigator.userAgent;
  // Chrome exposes window.chrome even in mobile device emulation mode
  const isChrome =
    typeof (window as unknown as { chrome?: unknown }).chrome !== "undefined";
  // Safari includes "Safari" but not "Chrome" or "Chromium" in its user agent
  // Also check window.chrome to avoid false positives in Chrome DevTools mobile emulation
  return (
    ua.includes("Safari") &&
    !ua.includes("Chrome") &&
    !ua.includes("Chromium") &&
    !isChrome
  );
}
