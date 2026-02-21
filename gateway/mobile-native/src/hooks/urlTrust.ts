export function isTrustedCurrentUrlForTokenPush(
  currentUrl: string | null,
  activeOrigin: string,
): boolean {
  if (!currentUrl) {
    return false;
  }

  try {
    return new URL(currentUrl).origin === activeOrigin;
  } catch {
    return false;
  }
}
