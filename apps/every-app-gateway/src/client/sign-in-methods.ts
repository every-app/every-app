import { useQuery } from "@tanstack/react-query";
import type { SignInMethods } from "@/auth/sign-in-methods";

/**
 * What the gateway's sign-in page offers: passwords (unless turned off),
 * "Continue with <label>" for Cloudflare Access, and who Access says this
 * browser belongs to when it came through the outer ring.
 */
export function useSignInMethods() {
  return useQuery({
    queryKey: ["auth", "sign-in-methods"],
    queryFn: async (): Promise<SignInMethods> => {
      const response = await fetch("/api/auth/sign-in-methods", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`sign-in-methods: HTTP ${response.status}`);
      }
      return (await response.json()) as SignInMethods;
    },
    staleTime: 60_000,
    // Never let a failure here keep the password form from showing.
    retry: 1,
  });
}

/**
 * Cloudflare Access's own sign-out, on the gateway's host: it ends the Access
 * session for every application, so the next page asks who you are again.
 */
export const ACCESS_SIGN_OUT_PATH = "/cdn-cgi/access/logout";

/**
 * Behind the outer ring, a browser can only be signed in as the person
 * Access says it belongs to: what to tell someone who signed in with an
 * account of another email.
 */
export function accessEmailMismatchMessage(
  accessEmail: string | null,
  accountEmail: string,
): string {
  const account = accountEmail.trim() || "this account's email";
  return accessEmail
    ? `You're signed in to Cloudflare Access as ${accessEmail}, but this account is ${account}, so this browser can't use it here. Sign out of Access and sign in there as ${account}, or ask an admin to invite ${accessEmail}.`
    : `Cloudflare Access knows you by another email than ${account}, so this browser can't use that account here. Sign out of Access and sign in there as ${account}, or ask an admin for help.`;
}

/**
 * What to tell someone a Cloudflare Access sign-in sent back with
 * `?error=<code>` (Better Auth's callback, or the gateway's membership
 * policy). `label` is the provider's button label; `accessEmail` who the
 * outer ring says is here, if it is on.
 */
export function accessSignInErrorMessage(
  code: string,
  label: string,
  passwordSignIn: boolean,
  accessEmail: string | null = null,
): string {
  switch (code) {
    case "ACCESS_NOT_INVITED":
      return "You don't have an account on this gateway yet. Ask an admin to invite you.";
    case "ACCESS_NOT_SET_UP":
      return "This gateway hasn't been set up yet: its owner has to claim it first.";
    case "ACCESS_ACCOUNT_DEACTIVATED":
    case "BANNED_USER":
      return "This account has been deactivated. Ask an admin to reactivate it.";
    case "account_not_linked":
      return passwordSignIn
        ? `An account with this email already exists. Sign in with its password once to connect ${label}; after that, ${label} signs you in.`
        : `An account with this email already exists but isn't connected to ${label} yet, and password sign-in is off. Ask an admin for help.`;
    case "email_does_not_match":
      return `That ${label} identity has a different email than this account, so it wasn't connected.`;
    case "PASSWORD_SIGN_IN_DISABLED":
      return `Password sign-in is turned off on this gateway. Continue with ${label}.`;
    case "ACCESS_EMAIL_MISMATCH":
      return accessEmail
        ? `You're signed in to Cloudflare Access as ${accessEmail}, but you signed in with ${label} as someone else. This browser can only be signed in as ${accessEmail} here.`
        : `Cloudflare Access knows you by another email than the account you signed in with, so this browser can't use it here.`;
    case "ACCESS_REQUIRED":
      return "This gateway signs people in through Cloudflare Access, and this page didn't come through it. Open the gateway at its own address.";
    default:
      return `Signing in with ${label} didn't finish. Please try again.`;
  }
}

/** What the sign-in page shows around its form. */
interface SignInPageParts {
  /** "Don't have an account? Sign up": only where anyone may sign up. */
  signUp: boolean;
  /**
   * "Continue with <label>" and its divider: not once Access has named the
   * person, since for them it ends where this page already is.
   */
  accessButton: boolean;
  /**
   * The blue note naming who Access says is here: not next to a red alert
   * that says the same thing.
   */
  accessNote: boolean;
  /**
   * "Not you? Sign out of Access" on the red alert: when the outer ring is
   * on, so the sign-out path exists on this host.
   */
  accessSignOut: boolean;
}

/**
 * What the sign-in page shows around its form, from what the methods say
 * and what is already on screen. Nothing shows before the methods load, so
 * nothing flashes and then goes away.
 */
export function signInPageParts(
  methods: SignInMethods | undefined,
  state: {
    /** A session exists; the page is only waiting to move on. */
    signedIn: boolean;
    /** The code of the Access refusal a red alert shows, if one does. */
    accessErrorCode: string | null;
  },
): SignInPageParts {
  const accessEmail = Boolean(methods?.accessEmail);
  const accessError = state.accessErrorCode !== null;
  return {
    signUp: methods?.signUp === "open",
    accessButton: Boolean(methods?.providers.length) && !accessEmail,
    accessNote: accessEmail && !state.signedIn && !accessError,
    accessSignOut:
      accessError &&
      (accessEmail || state.accessErrorCode === "ACCESS_EMAIL_MISMATCH"),
  };
}

/** Codes after which signing in with the password should connect Access. */
export function shouldLinkAfterPasswordSignIn(code: string | undefined) {
  return code === "account_not_linked";
}

const CONTINUE_KEY = "everyapp:auto-continue";
const CONTINUE_WINDOW_MS = 15_000;

/**
 * Whether the sign-in page may move a signed-in visitor on to `destination`
 * by itself. Not twice in a row within a few seconds: if the destination
 * sends the browser straight back (an app host that doesn't accept this
 * session), the page stops and asks instead of looping.
 */
export function mayAutoContinue(
  destination: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  now = Date.now(),
): boolean {
  if (!storage) return true;
  try {
    const last = JSON.parse(storage.getItem(CONTINUE_KEY) ?? "null") as {
      destination?: string;
      at?: number;
    } | null;
    if (
      last?.destination === destination &&
      typeof last.at === "number" &&
      now - last.at < CONTINUE_WINDOW_MS
    ) {
      return false;
    }
    storage.setItem(CONTINUE_KEY, JSON.stringify({ destination, at: now }));
  } catch {
    // Storage unavailable (private mode): move on without the loop guard.
  }
  return true;
}
