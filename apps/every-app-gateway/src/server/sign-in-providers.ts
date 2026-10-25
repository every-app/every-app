/**
 * The sign-in providers as Manage workspace → Sign-in and the
 * `everyapp_signin_list` / `everyapp_signin_show` tools show them: every
 * catalog provider (packages/sdk/src/internal/signInProviders.ts) in
 * order, with whether it is on, off or needs setup, which of its settings
 * are set, what the operator registers at the provider (the redirect URL)
 * and the command that sets it up.
 *
 * Read-only, and never a value: a setting is reported by its name and
 * whether it is set. The settings are Worker secrets the Gateway can't
 * write to itself (`everyapp signin add` sets them under the Cloudflare
 * login), so nothing here or in a tool changes them, and a stolen admin
 * session or agent token can't add a way in (threat model B10,
 * `signin.settings.secrets-only-family`, `signin.tools.read-state-only`).
 * The one text that comes from a setting is the `oidc` button's label, and
 * only for a provider that is on, where the sign-in page shows it to
 * anyone already.
 */
import { env } from "cloudflare:workers";
import {
  SIGN_IN_PROVIDER_LIST,
  isSignInProviderId,
  signInCallbackUrl,
  type SignInProvider,
  type SignInProviderId,
  type SignInProviderStatus,
  type SignInSettingRole,
} from "@every-app/sdk/internal";
import { accessConfigFromEnv } from "@/auth/cloudflare-access";
import { isPasswordSignInOn } from "@/auth/cloudflare-access/membership";
import {
  configuredSignInProviderIds,
  signInProvidersFromEnv,
} from "@/auth/sign-in-providers";
import { platformPolicy } from "@/server/platform-policy";

/** The command that sets a provider up, run under the gateway's Cloudflare login. */
function signInAddCommand(id: SignInProviderId): string {
  return `pnpm everyapp signin add ${id}`;
}

interface ListedSignInSetting {
  /** `GOOGLE_SIGNIN_CLIENT_ID`. */
  name: string;
  role: SignInSettingRole;
  required: boolean;
  /** A plain value (an id, a URL, a word), not a credential. */
  plain: boolean;
  /** One line: what to paste here. */
  what: string;
  /** Whether the Worker has it. Never its value. */
  set: boolean;
}

export interface ListedSignInProvider {
  id: SignInProviderId;
  /** "Continue with <label>". */
  label: string;
  status: SignInProviderStatus;
  /** The required settings not set. */
  missing: string[];
  /** The settings set, required or not. */
  set: string[];
  settings: ListedSignInSetting[];
  /** The redirect URL to register at the provider. */
  callbackUrl: string;
  /** Where the OAuth app is made. */
  console: string;
  /** What the OAuth app is called there. */
  appNoun: string;
  scopes: string[];
  emailClaim: string;
  notes: string[];
  /** The everyapp skill's guide, relative to the skill. */
  setup: string;
  /** What `everyapp signin add` is, for this provider. */
  command: string;
  /** Why a provider that needs setup is off (a missing or malformed setting). */
  problem?: string;
}

export interface SignInProvidersListing {
  providers: ListedSignInProvider[];
  /** Password sign-in beside the providers. */
  password: {
    /** Whether the sign-in page offers passwords right now. */
    on: boolean;
    /**
     * EMAIL_PASSWORD_SIGN_IN=false is set but waits for an owner to hold
     * another way in (an Access identity or a provider's), so passwords
     * stay on until then.
     */
    offPending: boolean;
  };
  /** Cloudflare Access's own sign-in ("Continue with <label>"), set with `everyapp access`. */
  access: { on: boolean; label: string | null };
  /**
   * Who runs `everyapp signin add`: on a self-hosted gateway whoever holds
   * its Cloudflare login; on the hosted one the platform's operator.
   */
  operator: "self_hosted" | "hosted";
}

/** The problem the settings reader reported for this provider, if any. */
function problemOf(
  provider: SignInProvider,
  problems: readonly string[],
): string | undefined {
  // The reader's problems name the provider's settings ("needs
  // GOOGLE_SIGNIN_CLIENT_SECRET", "OIDC_SIGNIN_ISSUER must be…"), never a
  // value.
  return problems.find((problem) =>
    provider.settings.some((setting) => problem.includes(setting.name)),
  );
}

/** Every catalog provider's state on this gateway, and passwords and Access beside them. */
export async function listSignInProviders(): Promise<SignInProvidersListing> {
  const config = signInProvidersFromEnv();
  const access = accessConfigFromEnv();
  const gatewayUrl = typeof env.GATEWAY_URL === "string" ? env.GATEWAY_URL : "";
  const providers = SIGN_IN_PROVIDER_LIST.map(
    (provider): ListedSignInProvider => {
      const state = config.states.find((entry) => entry.id === provider.id)!;
      const on = config.providers.find((entry) => entry.id === provider.id);
      const set = new Set(state.set);
      const problem =
        state.status === "incomplete"
          ? (problemOf(provider, config.problems) ??
            `${provider.label} sign-in needs ${state.missing.join(" and ") || "its settings checked"}; it is off.`)
          : undefined;
      return {
        id: provider.id,
        label: on?.label ?? provider.label,
        status: state.status,
        missing: [...state.missing],
        set: [...state.set],
        settings: provider.settings.map((setting) => ({
          name: setting.name,
          role: setting.role,
          required: setting.required,
          plain: setting.plain,
          what: setting.what,
          set: set.has(setting.name),
        })),
        callbackUrl: signInCallbackUrl(gatewayUrl, provider.id),
        console: provider.console,
        appNoun: provider.appNoun,
        scopes: [...provider.scopes],
        emailClaim: provider.emailClaim,
        notes: [...provider.notes],
        setup: provider.setup,
        command: signInAddCommand(provider.id),
        ...(problem ? { problem } : {}),
      };
    },
  );
  const passwordOn = await isPasswordSignInOn(
    access,
    configuredSignInProviderIds(config),
  );
  return {
    providers,
    password: {
      on: passwordOn,
      offPending: passwordOn && !access.passwordSignIn,
    },
    access: {
      on: Boolean(access.oidc),
      label: access.oidc?.label ?? null,
    },
    operator: platformPolicy(env).hosted ? "hosted" : "self_hosted",
  };
}

/** One provider's listing, or null for an id the catalog doesn't have. */
export async function showSignInProvider(
  id: string,
): Promise<ListedSignInProvider | null> {
  if (!isSignInProviderId(id)) return null;
  const { providers } = await listSignInProviders();
  return providers.find((provider) => provider.id === id) ?? null;
}
