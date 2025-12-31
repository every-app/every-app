/**
 * Validates if an origin matches an app's configured URLs (production or dev).
 *
 * @param origin - The origin to validate (e.g., "https://app.example.com")
 * @param appUrl - The app's production URL
 * @param devUrl - Optional development URL
 * @returns true if the origin matches either the production or dev URL
 */
export function isValidAppOrigin(
  origin: string,
  appUrl: string,
  devUrl?: string | null,
): boolean {
  try {
    const prodOrigin = new URL(appUrl).origin;
    if (origin === prodOrigin) {
      return true;
    }

    if (devUrl) {
      const devOrigin = new URL(devUrl).origin;
      if (origin === devOrigin) {
        return true;
      }
    }

    return false;
  } catch {
    // Invalid URL format
    return false;
  }
}

/**
 * Formats the expected origins for error messages.
 *
 * @param appUrl - The app's production URL
 * @param devUrl - Optional development URL
 * @returns A formatted string like "https://app.com" or "https://app.com or http://localhost:3001"
 */
export function formatExpectedOrigins(
  appUrl: string,
  devUrl?: string | null,
): string {
  try {
    const prodOrigin = new URL(appUrl).origin;
    if (devUrl) {
      const devOrigin = new URL(devUrl).origin;
      return `${prodOrigin} or ${devOrigin}`;
    }
    return prodOrigin;
  } catch {
    return appUrl;
  }
}
