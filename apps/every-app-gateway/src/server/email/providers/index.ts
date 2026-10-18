/**
 * The email providers, and which one sends. One provider serves the whole
 * gateway, its own mail (sign-up verification, invitations, password
 * resets) and every app's (capabilities/email.ts): the operator's choice,
 * EMAIL_PROVIDER, or the first set up (chooseEmailProvider in
 * @every-app/sdk/internal; docs/runbooks/email-sending-setup.md,
 * "Choosing a provider").
 */
import {
  EMAIL_PROVIDER_IDS,
  chooseEmailProvider,
  type EmailProviderId,
} from "@every-app/sdk/internal";
import { cloudflareEmailProvider } from "./cloudflare";
import { resendEmailProvider } from "./resend";
import type { EmailProvider, EmailProviderEnv } from "./types";

/** In the order an implicit choice prefers them (EMAIL_PROVIDER_IDS). */
export const EMAIL_PROVIDERS: readonly EmailProvider[] = [
  cloudflareEmailProvider,
  resendEmailProvider,
];

/** What a gateway sends mail with, as messages tell its operator. */
export const EMAIL_TRANSPORTS_TEXT =
  "one transport: Cloudflare Email Sending (the EMAIL binding, or EMAIL_REST_API_TOKEN with CLOUDFLARE_ACCOUNT_ID) or Resend (RESEND_API_KEY); EMAIL_PROVIDER picks one when both are set";

function providerFor(id: EmailProviderId): EmailProvider {
  return EMAIL_PROVIDERS.find((provider) => provider.id === id)!;
}

/** What a provider needs, for a message. */
function needs(provider: EmailProvider): string {
  const settings = provider.settings.join(" and ");
  return provider.id === "cloudflare"
    ? `${settings}, or give the Worker its EMAIL binding`
    : settings;
}

/**
 * The provider that sends, or why none can: an EMAIL_PROVIDER that isn't
 * a provider, or isn't set up, or no provider set up at all.
 */
export function selectEmailProvider(
  env: EmailProviderEnv,
):
  | { provider: EmailProvider }
  | { error: "not_configured" | "unknown_provider"; message: string } {
  const choice = chooseEmailProvider(env.EMAIL_PROVIDER, (id) =>
    providerFor(id).setup(env),
  );
  if (choice.ok) return { provider: providerFor(choice.provider) };
  if (choice.error === "unknown_provider") {
    return {
      error: "unknown_provider",
      message: `Email delivery is unavailable: EMAIL_PROVIDER is ${JSON.stringify(choice.requested.slice(0, 40))}, which isn't an email provider. Set it to ${EMAIL_PROVIDER_IDS.join(" or ")}, or unset it.`,
    };
  }
  if (choice.requested) {
    const provider = providerFor(choice.requested);
    return {
      error: "not_configured",
      message: `Email delivery is unavailable: EMAIL_PROVIDER picks ${provider.label}, which isn't set up on this gateway. Set ${needs(provider)}.`,
    };
  }
  return {
    error: "not_configured",
    message: `Email delivery is unavailable: no email provider is set up. Give the gateway ${EMAIL_TRANSPORTS_TEXT}.`,
  };
}

/**
 * The providers' state, for the capability status and admin pages: the one
 * that sends (null when none can), and every one that could.
 */
export function emailProviderStatus(env: EmailProviderEnv): {
  provider: EmailProviderId | null;
  configured: boolean;
  available: EmailProviderId[];
} {
  const selected = selectEmailProvider(env);
  const provider = "provider" in selected ? selected.provider.id : null;
  return {
    provider,
    configured: provider !== null,
    available: EMAIL_PROVIDERS.filter((candidate) =>
      candidate.configured(env),
    ).map((candidate) => candidate.id),
  };
}
