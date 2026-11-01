/**
 * Shared platform detection utilities for client-side code.
 */

export type Platform = "ios" | "android" | "desktop" | "unknown";

/**
 * Detect the current platform based on user agent.
 * Returns "unknown" when running on the server.
 */
export function detectPlatform(): Platform {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "unknown";
  }

  const userAgent = navigator.userAgent;

  // iOS detection (case-insensitive)
  if (/iPad|iPhone|iPod/i.test(userAgent)) {
    return "ios";
  }

  // Android detection (case-insensitive)
  if (/Android/i.test(userAgent)) {
    return "android";
  }

  return "desktop";
}

/**
 * Check if the app is running as a PWA (installed to home screen).
 */
export function isPWAStandalone(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  // Check for standalone display mode (works on most browsers)
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;

  // Check for iOS Safari standalone mode
  const isIOSStandalone =
    "standalone" in window.navigator &&
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true;

  return isStandalone || isIOSStandalone;
}
