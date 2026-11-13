/**
 * Manage workspace → Sign-in's words, as data: how a provider's status
 * reads in the list, and what its setup dialog says. The listing comes from
 * the server (server/sign-in-providers.ts); nothing here or on the page
 * changes a setting, since they are Worker secrets set from a terminal.
 */
import type {
  ListedSignInProvider,
  SignInProvidersListing,
} from "@/server/sign-in-providers";

export type { ListedSignInProvider };

/** What a provider's row shows: the status and the button beside it. */
export function signInStatusView(provider: ListedSignInProvider): {
  label: "On" | "Needs setup" | "Off";
  /** The button that opens the dialog. */
  action: "Details" | "Needs setup" | "Set up";
} {
  switch (provider.status) {
    case "on":
      return { label: "On", action: "Details" };
    case "incomplete":
      return { label: "Needs setup", action: "Needs setup" };
    case "off":
      return { label: "Off", action: "Set up" };
  }
}

interface SignInSetupSettingRow {
  name: string;
  what: string;
  /** "Set", "Not set", or "Optional" for an optional one that isn't set. */
  state: "Set" | "Not set" | "Optional";
}

interface SignInSetupDialogModel {
  title: string;
  /** Already on: the dialog shows what is set, not the steps to set it up. */
  on: boolean;
  /** Why it is off, for a provider that needs setup. */
  problem: string | null;
  /** The provider's console, when it is a link. */
  console: { href: string; label: string } | null;
  /** Where to make the OAuth app, when the console isn't a link (an OIDC issuer). */
  consoleText: string | null;
  appNoun: string;
  callbackUrl: string;
  settings: SignInSetupSettingRow[];
  /** "Run this in a terminal" for the operator, "Ask … to run this" otherwise. */
  commandHeading: string;
  command: string;
  notes: string[];
  /** The setup guide, relative to the agent docs (`setup/signin-google.md`). */
  guide: string;
}

const RUN_IT = "Run this in a terminal";
const ASK = "Ask the gateway's operator to run this";
const ON_COMMAND = "To change a setting, run this again";

function consoleLink(console: string): { href: string; label: string } | null {
  if (!/^https:\/\//.test(console)) return null;
  try {
    const url = new URL(console);
    return { href: console, label: url.host };
  } catch {
    return null;
  }
}

/**
 * The setup dialog for one provider. `canRun`: the reader can run `everyapp
 * signin add` (a self-hosted gateway's owner or admin, who may hold its
 * Cloudflare login); on the hosted gateway the platform's operator does.
 */
export function signInSetupDialogModel(
  provider: ListedSignInProvider,
  { canRun }: { canRun: boolean },
): SignInSetupDialogModel {
  const on = provider.status === "on";
  const link = consoleLink(provider.console);
  return {
    title: on
      ? `Sign in with ${provider.label}`
      : `Set up sign-in with ${provider.label}`,
    on,
    problem:
      provider.status === "incomplete" ? (provider.problem ?? null) : null,
    console: link,
    consoleText: link ? null : provider.console,
    appNoun: provider.appNoun,
    callbackUrl: provider.callbackUrl,
    settings: provider.settings.map((setting) => ({
      name: setting.name,
      what: setting.what,
      state: setting.set ? "Set" : setting.required ? "Not set" : "Optional",
    })),
    commandHeading: !canRun ? ASK : on ? ON_COMMAND : RUN_IT,
    command: provider.command,
    notes: provider.notes,
    guide: provider.setup,
  };
}

/**
 * The banner over the page while Cloudflare Access is in front of the
 * gateway (the outer ring): Access signs people in, so the providers only
 * matter for running without it.
 */
export const OUTER_RING_BANNER = {
  title: "Cloudflare Access signs people in to this workspace.",
  description: "Nothing to set up here while Access is on.",
} as const;

/** The outer ring's row: on, and how it is set. */
export const OUTER_RING_DETAIL = "Set with";

const TURN_OFF =
  "To turn it off, run pnpm everyapp secret set EMAIL_PASSWORD_SIGN_IN and answer false.";

/**
 * The password row's words: on, off, or off once an owner connects a
 * provider. Behind the outer ring (`outerRing`) a password session counts
 * only for the person Access vouches for on the request (the Access
 * plugin's hooks), so it is no fallback and no way around Access.
 */
export function passwordSignInView(
  password: SignInProvidersListing["password"],
  { outerRing = false }: { outerRing?: boolean } = {},
): { label: "On" | "Off"; note: string } {
  if (outerRing) {
    if (!password.on) {
      return {
        label: "Off",
        note: "Access signs everyone in.",
      };
    }
    return {
      label: "On",
      note: password.offPending
        ? "Turns off once an owner opens the workspace through Access."
        : `Works only for people Access lets in. ${TURN_OFF}`,
    };
  }
  if (!password.on) {
    return {
      label: "Off",
      note: "People sign in with the providers below.",
    };
  }
  return {
    label: "On",
    note: password.offPending
      ? "Turns off once an owner connects a provider below (account menu → Connect)."
      : `${TURN_OFF} It takes effect once an owner has connected a provider below.`,
  };
}
