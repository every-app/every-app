/**
 * The checks a sign-in provider's plain settings get before anything is
 * written, whether `everyapp signin add` or `everyapp secret set` writes
 * them: the same rules the Gateway reads them by
 * (apps/every-app-gateway/src/auth/sign-in-providers/config.ts), so a value
 * the Gateway would refuse (and keep the provider off for, with only a log
 * line to say so) is refused here, where it can be fixed. Without the
 * Gateway's loopback allowance, which is for a mock provider in local
 * development only.
 */
import { signInProviderOfSetting, type SignInSettingRole } from "@every-app/sdk/internal";

/** The button text's length limit (the Gateway's MAX_LABEL_LENGTH). */
const MAX_LABEL_LENGTH = 40;
/** A Microsoft tenant: a GUID, or one of the login.microsoftonline.com words (the Gateway's TENANT). */
const TENANT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|common|organizations|consumers)$/i;

/** What each checked role takes, as a prompt's context line and a refusal's fix say it. */
const TAKES: Partial<Record<SignInSettingRole, string>> = {
  issuer: "the issuer's https URL, which serves /.well-known/openid-configuration (no query, fragment or user:password@)",
  tenant: "the Directory (tenant) ID, a GUID like 72f988bf-86f1-41af-91ab-2d7cd011db47, or common, organizations or consumers",
  label: `the button text after "Continue with", at most ${MAX_LABEL_LENGTH} characters`,
};

/**
 * Why `value` (trimmed, non-empty) won't do for a setting of `role`, in one
 * sentence; null when the Gateway will read it.
 */
export function signInValueProblem(role: SignInSettingRole, value: string): string | null {
  switch (role) {
    case "issuer": {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return `"${value}" isn't a URL.`;
      }
      if (url.protocol !== "https:") return `"${value}" isn't an https URL.`;
      if (url.username || url.password) return "It carries a user name or password; the issuer's URL has none.";
      if (url.search || url.hash) return "It has a query or a fragment; the issuer's URL has neither.";
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1") {
        return "A deployed Gateway can't reach a loopback issuer.";
      }
      return null;
    }
    case "tenant":
      return TENANT.test(value) ? null : `"${value}" isn't a Directory (tenant) ID, common, organizations or consumers.`;
    case "label":
      return value.length <= MAX_LABEL_LENGTH ? null : `It is ${value.length} characters; the button takes ${MAX_LABEL_LENGTH} at most.`;
    default:
      return null;
  }
}

/** What a setting of `role` takes, for a prompt's context line; null for a role taking any value. */
export function signInValueTakes(role: SignInSettingRole): string | null {
  return TAKES[role] ?? null;
}

/**
 * For `secret set`: a sign-in provider's plain setting by name, with its
 * check, or undefined when `name` isn't one (or takes any value: a client id).
 */
export function signInPlainSetting(
  name: string,
): { takes: string; check: (value: string) => string | null } | undefined {
  const setting = signInProviderOfSetting(name)?.settings.find((each) => each.name === name);
  const takes = setting ? signInValueTakes(setting.role) : null;
  if (!setting || !takes) return undefined;
  return { takes, check: (value) => signInValueProblem(setting.role, value) };
}
