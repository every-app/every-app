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
