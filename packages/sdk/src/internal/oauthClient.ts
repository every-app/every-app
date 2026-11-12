/**
 * An OAuth provider's client as the gateway holds it in its settings
 * (`everyapp secret set <CLIENT_ID> <CLIENT_SECRET>`); one an owner or
 * admin pasted under Manage workspace → Providers is the gateway's own
 * D1 row instead.
 */
import type {
  CapabilitySettings,
  OAuthClientCapability,
} from "./capabilities.js";
import { providerBindingKey } from "./providerRegistry.js";

/** The largest token answer the gateway reads: real ones are a few kilobytes. */
export const OAUTH_TOKEN_BODY_LIMIT = 64 * 1024;

/** An OAuth client as the gateway holds it. */
export interface OAuthClientCredentials {
  clientId: string;
  /** Absent for a public client. */
  clientSecret?: string;
}

/**
 * The client `settings` hold for `capability`, or null until every setting
 * it needs is set: the id, and the secret unless it is a public client.
 */
export function oauthClientCredentials(
  capability: OAuthClientCapability,
  settings: CapabilitySettings,
): OAuthClientCredentials | null {
  const clientId = settingValue(settings[capability.secrets.clientId]);
  const secretName = capability.secrets.clientSecret;
  const clientSecret = secretName
    ? settingValue(settings[secretName])
    : undefined;
  if (!clientId || (secretName && !clientSecret)) return null;
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** Where the client the gateway uses for an OAuth provider comes from. */
export enum OAuthClientSource {
  /** The Worker's settings, set from the terminal (`everyapp secret set`, `provider add`). */
  Env = "env",
  /** Pasted under Manage workspace → Providers: the gateway's sealed D1 row. */
  Pasted = "d1",
}

/** What the gateway or the CLI knows of a pasted client, never its value. */
export interface PastedOAuthClient {
  /** The provider binding it was pasted for (`providerBindingKey`), or null for none recorded. */
  boundTo: string | null;
  hasSecret: boolean;
  /** Whether its sealed copy opens with the gateway's secret; the CLI, which can't open it, says true. */
  opens: boolean;
}

/**
 * Which client the gateway uses for an OAuth provider, or null when it has
 * none it may use (docs/design/2026-10-oauth-providers.md section 6): the
 * Worker settings' while the registry may read them (`envBound`: a
 * registered row bound to its hosts), else the pasted one while it was
 * pasted for the provider as it is now, opens, and has its secret. One rule
 * for every surface that asks: the gateway's client lookup, whether an app
 * needs setup (the gate that opens it, the app lists) and the CLI's
 * `status` and `deploy`.
 */
export function oauthClientSource(input: {
  capability: OAuthClientCapability;
  /** Every setting the Worker's client needs is set (`oauthClientCredentials`). */
  envSet: boolean;
  envBound: boolean;
  pasted: PastedOAuthClient | null;
}): OAuthClientSource | null {
  if (input.envSet) return input.envBound ? OAuthClientSource.Env : null;
  const pasted = input.pasted;
  if (!pasted || !pasted.opens) return null;
  if (pasted.boundTo !== providerBindingKey(input.capability)) return null;
  if (input.capability.secrets.clientSecret && !pasted.hasSecret) return null;
  return OAuthClientSource.Pasted;
}

function settingValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
