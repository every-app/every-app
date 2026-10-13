import { env } from "cloudflare:workers";

/**
 * Links the gateway hands out by email or for an admin to copy. Secrets go
 * in the query string of a gateway page, never in a path, so Workers Logs
 * query-string redaction covers them.
 */
export function invitationUrl(token: string): string {
  return `${env.GATEWAY_URL}/accept-invitation?token=${encodeURIComponent(token)}`;
}

export function passwordResetUrl(token: string): string {
  return `${env.GATEWAY_URL}/reset-password?token=${encodeURIComponent(token)}`;
}
