import { authClient } from "@/src/lib/auth-client";

/** How a "Continue with <label>" sign-in ended. */
export type AccessSignInResult =
  | { status: "signed-in" }
  | { status: "canceled" }
  | { status: "refused"; code: string };

/** The error code a gateway answer carries (Better Auth's `code`). */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "unknown";
}

/** What the sign-in needs from the device (injected for tests). */
export interface AccessSignInDevice {
  /** The app's deep link the browser comes back to (`everyapp:///sign-in`). */
  redirectURL: string;
  /** expo-web-browser's auth session: the system browser, never a WebView. */
  openAuthSession(
    url: string,
    redirectURL: string,
  ): Promise<{ type: string; url?: string }>;
}

/**
 * Sign in with Cloudflare Access (OIDC) through the system browser, and hand
 * the session to the app (the gateway's mobile-sign-in handoff):
 *
 *  1. ask the gateway to start: a one-time link, and a secret that stays in
 *     this process and never goes through the browser;
 *  2. open the link in the system browser, where the gateway runs the whole
 *     Access sign-in (its OAuth state is bound to that browser) and comes
 *     back to the app with a one-time code, or the reason it was refused;
 *  3. trade the code and the secret for the session, which the Better Auth
 *     Expo client stores like the cookie of a password sign-in.
 *
 * Better Auth Expo's own social sign-in isn't used: the gateway closes its
 * authorization proxy, which let any site plant a sign-in in a browser.
 */
export async function signInWithAccess(
  provider: string,
  device: AccessSignInDevice,
): Promise<AccessSignInResult> {
  const started = await authClient.$fetch<{ url: string; secret: string }>(
    "/mobile-sign-in/start",
    { method: "POST", body: { provider, redirectURL: device.redirectURL } },
  );
  if (!started.data) {
    return { status: "refused", code: errorCode(started.error) };
  }
  const { url, secret } = started.data;

  const result = await device.openAuthSession(url, device.redirectURL);
  if (result.type !== "success" || !result.url) return { status: "canceled" };

  let back: URL;
  try {
    back = new URL(result.url);
  } catch {
    return { status: "refused", code: "unknown" };
  }
  const refused = back.searchParams.get("error");
  if (refused) return { status: "refused", code: refused };
  const code = back.searchParams.get("code");
  if (!code) return { status: "refused", code: "unknown" };

  const finished = await authClient.$fetch("/mobile-sign-in/finish", {
    method: "POST",
    body: { code, secret },
  });
  if (finished.error) {
    return { status: "refused", code: errorCode(finished.error) };
  }
  return { status: "signed-in" };
}

/** What to tell someone an Access sign-in came back refused with `code`. */
export function accessSignInErrorMessage(code: string, label: string): string {
  switch (code) {
    case "ACCESS_NOT_INVITED":
      return "You don't have an account on this gateway yet. Ask an admin to invite you.";
    case "ACCESS_NOT_SET_UP":
      return "This gateway hasn't been set up yet: its owner has to claim it first.";
    case "ACCESS_ACCOUNT_DEACTIVATED":
    case "BANNED_USER":
      return "This account has been deactivated. Ask an admin to reactivate it.";
    case "account_not_linked":
      return `An account with this email already exists but isn't connected to ${label} yet. Sign in with its password, or connect ${label} once on the web: sign in there and choose Connect ${label} in the account menu.`;
    case "INVALID_MOBILE_SIGN_IN_CODE":
      return `Signing in with ${label} took too long. Please try again.`;
    default:
      return `Signing in with ${label} didn't finish. Please try again.`;
  }
}
