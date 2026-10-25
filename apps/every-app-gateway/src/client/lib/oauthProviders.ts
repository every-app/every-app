import { providerSettingPrefix } from "@every-app/sdk/internal";

/**
 * Pure helpers behind Admin → Providers and Settings → Connected accounts
 * (docs/design/2026-10-oauth-providers.md sections 5 and 9): the connect
 * path a button links to, and the words each state reads as. Tested
 * without React.
 */

type ConnectAccount = "user" | "organization";

/** The custom provider form's values, as the Add dialog takes them. */
interface CustomProviderForm {
  name: string;
  id: string;
  console: string;
  authorizeUrl: string;
  tokenUrl: string;
  hosts: string;
  scopes: string;
  inject: "form" | "basic";
  pkce: boolean;
  writes: boolean;
}

/** The path on this Gateway that starts the OAuth flow for `providerId`. */
export function connectPathFor(
  providerId: string,
  options: { account: ConnectAccount; returnTo?: string; sets?: string[] },
): string {
  const params = new URLSearchParams();
  params.set("account", options.account);
  if (options.returnTo) params.set("return", options.returnTo);
  if (options.sets && options.sets.length > 0) {
    params.set("sets", options.sets.join(","));
  }
  return `/connect/${encodeURIComponent(providerId)}?${params.toString()}`;
}

/** Where the person lands after connecting from Settings → Connected accounts. */
export const ACCOUNTS_RETURN_PATH = "/settings/accounts";

/** What the Client column says. */
export function clientSourceLabel(client: { source: "env" | "d1" | null }): {
  label: string;
  tone: "set" | "unset";
} {
  switch (client.source) {
    case "env":
      return { label: "Set from the terminal", tone: "set" };
    case "d1":
      return { label: "Pasted here", tone: "set" };
    default:
      return { label: "No client", tone: "unset" };
  }
}

/** The one-line notice the callback's return carries, by query. */
export function callbackNotice(search: {
  connected?: string;
  error?: string;
}): { kind: "success" | "error"; text: string } | null {
  if (search.connected) {
    return { kind: "success", text: `${search.connected} connected.` };
  }
  if (search.error) {
    return { kind: "error", text: connectErrorText(search.error) };
  }
  return null;
}

/** The provider's or the Gateway's refusal, in plain words. */
export function connectErrorText(code: string): string {
  switch (code) {
    case "access_denied":
      return "You cancelled at the provider; nothing was connected.";
    case "state_invalid":
    case "state_expired":
      return "That sign-in took too long or was already used. Try again.";
    case "scope_refused":
    case "integration_scope_exceeded":
      return "The provider granted other scopes than asked; nothing was stored. Try again and accept every scope.";
    case "client_missing":
    case "integration_not_configured":
      return "This provider has no client yet. An owner or admin adds one under Manage workspace → Providers.";
    case "token_exchange_failed":
      return "The provider refused the code exchange. Check the client id, the secret and the redirect URI.";
    default:
      return `Couldn't connect (${code}).`;
  }
}

/** The scope sets a chip row shows: names, or "all" when none were recorded. */
export function scopeSetsText(sets: readonly string[]): string {
  return sets.length > 0 ? sets.join(", ") : "default";
}

const SLUG = /[^a-z0-9-]+/g;

/** `Acme Cloud` → `acme-cloud`, for the id a custom provider gets by default. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(SLUG, "")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

/** The spec of design section 3 from the custom form's values. */
export function customSpecOf(
  value: CustomProviderForm,
): Record<string, unknown> {
  const prefix = providerSettingPrefix(value.id);
  const scopes = value.scopes
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const hosts = value.hosts
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const access = value.writes ? "write" : "read";
  return {
    id: value.id,
    name: value.name,
    docs: value.console,
    hosts,
    auth: {
      kind: "oauth2-user",
      authorizeUrl: value.authorizeUrl,
      tokenUrl: value.tokenUrl,
      clientId: `${prefix}CLIENT_ID`,
      clientSecret: `${prefix}CLIENT_SECRET`,
      inject: value.inject,
      pkce: value.pkce,
      scopeDialect: "space",
    },
    scopeSets: {
      default: {
        label: `${value.name} access`,
        access,
        scopes,
      },
    },
    access: value.writes ? ["read", "write"] : ["read"],
  };
}
