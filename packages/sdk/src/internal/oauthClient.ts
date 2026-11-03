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

function settingValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
