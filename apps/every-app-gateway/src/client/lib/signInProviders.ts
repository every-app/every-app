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

/** The page's lead, under its heading. */
export const SIGN_IN_LEAD =
  "People can sign in with these beside their password. Settings are Worker secrets, set from a terminal: nothing here changes them.";

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
  intro: string;
  /** Why it is off, for a provider that needs setup. */
  problem: string | null;
  /** The provider's console, when it is a link. */
  console: { href: string; label: string } | null;
  /** Where to make the OAuth app, when the console isn't a link (an OIDC issuer). */
  consoleText: string | null;
  appNoun: string;
  callbackUrl: string;
  settings: SignInSetupSettingRow[];
  /** "Run it in a terminal…" for the operator, "Ask … to run:" otherwise. */
  commandHeading: string;
  command: string;
  notes: string[];
  /** The everyapp skill's guide. */
  guide: string;
}

const RUN_IT =
  "Then run this in a terminal with this gateway's Cloudflare login; it asks for each setting, the secret hidden:";
const ASK =
  "Then ask the gateway's operator to run this (it needs the gateway's Cloudflare login):";
const ON_COMMAND =
  "To change a setting (a new client secret), run it again in a terminal with this gateway's Cloudflare login:";

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
    intro: on
      ? `On: the sign-in page shows "Continue with ${provider.label}". The ${provider.appNoun} at the provider must keep this redirect URL.`
      : `Make a ${provider.appNoun} at the provider with the redirect URL below, then set its settings. The sign-in page shows "Continue with ${provider.label}" once every required one is set.`,
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

/** The password row's words: on, off, or off once an owner connects a provider. */
export function passwordSignInView(
  password: SignInProvidersListing["password"],
): { label: "On" | "Off"; note: string } {
  if (!password.on) {
    return {
      label: "Off",
      note: "EMAIL_PASSWORD_SIGN_IN=false: people sign in with the providers below. Unset it from a terminal to bring passwords back.",
    };
  }
  return {
    label: "On",
    note: password.offPending
      ? "EMAIL_PASSWORD_SIGN_IN=false is set, but passwords stay on until an owner has connected one of the ways below (account menu → Connect), so nobody is locked out."
      : "Set EMAIL_PASSWORD_SIGN_IN=false from a terminal to turn passwords off; it takes effect once an owner has connected one of the ways below.",
  };
}
