import { providerSettingPrefix } from "@every-app/sdk/internal";

/**
 * Pure helpers behind Manage workspace → Providers and Your connections →
 * Accounts (docs/design/2026-11-oauth-simplify.md): the words
 * each state reads as, and the custom provider's spec. Tested without
 * React.
 */

/** The custom provider form's values, as the Add dialog takes them. */
interface CustomProviderForm {
  name: string;
  id: string;
  console: string;
  authorizeUrl: string;
  tokenUrl: string;
  hosts: string;
  scopeSeparator: "space" | "comma";
  inject: "form" | "basic";
  pkce: boolean;
}

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

/** A connection's scopes as a line: the provider's own names, or "no scopes". */
export function scopesText(scopes: readonly string[]): string {
  return scopes.length > 0 ? scopes.join(", ") : "no scopes";
}

/** A space- or comma-separated field as a list, blanks dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
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

/** A provider spec (./oauthSpec.ts in the SDK) from the custom form's values. */
export function customSpecOf(
  value: CustomProviderForm,
): Record<string, unknown> {
  const prefix = providerSettingPrefix(value.id);
  return {
    id: value.id,
    name: value.name,
    docs: value.console,
    hosts: splitList(value.hosts).map((host) => host.toLowerCase()),
    auth: {
      kind: "oauth2-user",
      authorizeUrl: value.authorizeUrl,
      tokenUrl: value.tokenUrl,
      clientId: `${prefix}CLIENT_ID`,
      clientSecret: `${prefix}CLIENT_SECRET`,
      inject: value.inject,
      pkce: value.pkce,
      scopeSeparator: value.scopeSeparator,
    },
  };
}
