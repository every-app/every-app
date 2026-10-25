import { Cloud, KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { ACCESS_PROVIDER_ID } from "@/client/sign-in-methods";

/**
 * The icon on a "Continue with <label>" button. Lucide carries no brand
 * marks for Google, Microsoft or Apple (and deprecates the ones it had), and
 * the repo draws none of its own, so the brands share a neutral sign-in
 * icon; Cloudflare Access keeps its shield, an OIDC issuer (your SSO) a key,
 * Cloudflare a cloud.
 */
export function SignInProviderIcon({ id }: { id: string }) {
  const Icon =
    id === ACCESS_PROVIDER_ID
      ? ShieldCheck
      : id === "oidc"
        ? KeyRound
        : id === "cloudflare"
          ? Cloud
          : LogIn;
  return <Icon data-icon="inline-start" aria-hidden />;
}
