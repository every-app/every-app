import { useQuery } from "@tanstack/react-query";
import { SIGN_IN_PROVIDERS, isSignInProviderId } from "@every-app/sdk/internal";
import type { SignInMethods } from "@/auth/sign-in-methods";

/**
 * Cloudflare Access's provider id on Better Auth (the gateway's
 * ACCESS_PROVIDER_ID in auth/cloudflare-access/config.ts, which the client
 * can't import: that module reads the Worker's settings).
 */
export const ACCESS_PROVIDER_ID = "cloudflare-access";

/**
 * What the gateway's sign-in page offers: passwords (unless turned off),
 * "Continue with <label>" for Cloudflare Access and for each sign-in
 * provider that is on, and who Access says this browser belongs to when it
 * came through the outer ring.
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

/** A provider the sign-in page offers: Cloudflare Access or a sign-in provider. */
type OfferedProvider = SignInMethods["providers"][number];

/**
 * Which provider a `?error=` came back from. The page sends every
 * provider's sign-in and link back with `provider=<id>` on its error URL;
 * an Access refusal (`ACCESS_*`) is Access's; anything else without a
 * provider (an old link) is read as the first one offered, as before
 * providers. Null when the methods haven't loaded or offer none: the
 * message then names the provider from the catalog (signInErrorLabel).
 */
export function signInErrorProvider(
  methods: Pick<SignInMethods, "providers"> | undefined,
  providerParam: string | undefined,
  code: string | undefined,
): OfferedProvider | null {
  const providers = methods?.providers ?? [];
  if (providerParam) {
    const named = providers.find((provider) => provider.id === providerParam);
    if (named) return named;
  }
  if (code?.startsWith("ACCESS_")) {
    return (
      providers.find((provider) => provider.id === ACCESS_PROVIDER_ID) ?? null
    );
  }
  return providerParam ? null : (providers[0] ?? null);
}

/**
 * The name a refusal uses for its provider: the one offered, else the
 * catalog's name for the `provider=` id (the methods didn't load, or the
 * provider has since been turned off), else Cloudflare Access's.
 */
export function signInErrorLabel(
  provider: OfferedProvider | null,
  providerParam: string | undefined,
): string {
  if (provider) return provider.label;
  if (providerParam && isSignInProviderId(providerParam)) {
    return SIGN_IN_PROVIDERS[providerParam].label;
  }
  return providerParam && providerParam !== ACCESS_PROVIDER_ID
    ? "your sign-in provider"
    : "Cloudflare Access";
}

/**
 * What to tell someone a provider sign-in (Cloudflare Access, Google,
 * Microsoft, GitHub, Apple, Cloudflare, SSO) sent back with `?error=<code>`
 * (Better Auth's callback, or the gateway's membership policy:
 * `ACCESS_*` from cloudflare-access/membership.ts, `SIGNIN_*` from
 * sign-in-providers/membership.ts), or a sign-in that couldn't start.
 * `label` is the provider's button label; `accessEmail` who the outer ring
 * says is here, if it is on.
 */
export function signInErrorMessage(
  code: string,
  label: string,
  passwordSignIn: boolean,
  accessEmail: string | null = null,
): string {
  switch (code) {
    case "ACCESS_NOT_INVITED":
    case "SIGNIN_NOT_INVITED":
      return "You don't have an account on this gateway yet. Ask an admin to invite you.";
    case "ACCESS_NOT_SET_UP":
    case "SIGNIN_NOT_SET_UP":
      return "This gateway hasn't been set up yet: its owner has to claim it first.";
    case "ACCESS_ACCOUNT_DEACTIVATED":
    case "SIGNIN_ACCOUNT_DEACTIVATED":
    case "BANNED_USER":
      return "This account has been deactivated. Ask an admin to reactivate it.";
    case "SIGNIN_EMAIL_NOT_VERIFIED":
    case "email_not_verified":
      return `${label} hasn't verified this email address, so it can't be used here.`;
    case "SIGNIN_PROVIDER_UNAVAILABLE":
      return `${label} couldn't be reached. Try again in a moment.`;
    case "account_not_linked":
      return passwordSignIn
        ? `An account with this email already exists. Sign in with its password once to connect ${label}; after that, ${label} signs you in.`
        : `An account with this email already exists but isn't connected to ${label} yet, and password sign-in is off. Ask an admin for help.`;
    case "email_does_not_match":
      return `That ${label} identity has a different email than this account, so it wasn't connected.`;
    case "unable_to_link_account":
      return `${label} hasn't verified that email, so it wasn't connected.`;
    case "account_already_linked_to_different_user":
      return `That ${label} identity is already connected to another account here, so it wasn't connected to this one.`;
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
   * One "Continue with <label>" per provider offered, in the methods'
   * order (Cloudflare Access first), and the divider when there is any.
   * Access's own is left out once Access has named the person, since for
   * them it ends where this page already is. The sign-in providers stay:
   * behind the outer ring a provider sign-in still makes a session only for
   * the person Access vouches for (threat model B10,
   * `signin.access-ring-unchanged`), so offering them can't let anyone
   * else in, and it is how that person reaches an account they hold
   * through Google or their SSO, or accepts an invitation with it.
   */
  buttons: OfferedProvider[];
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
    /** The code of the provider refusal a red alert shows, if one does. */
    errorCode: string | null;
  },
): SignInPageParts {
  const accessEmail = Boolean(methods?.accessEmail);
  const refused = state.errorCode !== null;
  return {
    signUp: methods?.signUp === "open",
    buttons: (methods?.providers ?? []).filter(
      (provider) => !(accessEmail && provider.id === ACCESS_PROVIDER_ID),
    ),
    accessNote: accessEmail && !state.signedIn && !refused,
    accessSignOut:
      refused && (accessEmail || state.errorCode === "ACCESS_EMAIL_MISMATCH"),
  };
}

/**
 * The ways in the page offers besides passwords, as words: "Google or
 * GitHub", "Company SSO, Google or GitHub". With none offered but the
 * outer ring (Access named the person, or the ring alone is on), Cloudflare
 * Access.
 */
export function offeredProvidersText(
  methods: Pick<SignInMethods, "providers"> | undefined,
): string {
  const labels = (methods?.providers ?? []).map((provider) => provider.label);
  if (labels.length === 0) return "Cloudflare Access";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)!}`;
}

/**
 * The account menu's "Connect <label>" items: each provider offered that
 * this account has no identity of yet (`listAccounts`), in the offered
 * order. None until the accounts are read, so no item flashes.
 */
export function connectableProviders(
  methods: Pick<SignInMethods, "providers"> | undefined,
  linkedProviderIds: readonly string[] | undefined,
): OfferedProvider[] {
  if (!linkedProviderIds) return [];
  return (methods?.providers ?? []).filter(
    (provider) => !linkedProviderIds.includes(provider.id),
  );
}

/** Where a failed Connect <label> lands: the sign-in page, which explains it. */
export function connectErrorPath(providerId: string): string {
  return `/sign-in?provider=${encodeURIComponent(providerId)}`;
}

/** Codes after which signing in with the password should connect the provider. */
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
