/**
 * Invite link secrets (`einv_` + 32 random bytes, base64url).
 *
 * The invitation id is not a secret (admins see it, and Better Auth has
 * handed it to members), so a link carries one of these instead. Only the
 * SHA-256 is stored (invitation_link_tokens): 256 bits of entropy need no
 * slow hash. Signing up through an invitation and accepting one both need a
 * live token.
 */
import { maskEmail } from "./mask-email";
import { InvitationLinkRepository } from "./repositories/InvitationLinkRepository";
import { OrganizationRepository } from "./repositories/OrganizationRepository";

const INVITATION_TOKEN_PREFIX = "einv_";

export function generateInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64url = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${INVITATION_TOKEN_PREFIX}${base64url}`;
}

export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The pending, unexpired invitation an invite link's token opens, or null
 * for an unknown, used, canceled or expired one.
 */
export async function findPendingInvitationByToken(
  token: string,
  now = new Date(),
) {
  if (!token.startsWith(INVITATION_TOKEN_PREFIX)) return null;
  const invitation = await InvitationLinkRepository.findInvitationByTokenHash(
    await hashInvitationToken(token),
  );
  if (
    !invitation ||
    invitation.status !== "pending" ||
    invitation.expiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  return invitation;
}

/**
 * What an invite link may show before anyone signs in: the organization's
 * name and the invited address, masked. Null for an unknown, used, canceled
 * or expired token alike, so the lookup tells a prober nothing about a
 * token that isn't live.
 */
export async function peekInvitation(
  token: string,
  now = new Date(),
): Promise<{ organizationName: string; invitedEmail: string } | null> {
  const invitation = await findPendingInvitationByToken(token, now);
  if (!invitation) return null;
  const organization = await OrganizationRepository.findSummaryById(
    invitation.organizationId,
  );
  if (!organization) return null;
  return {
    organizationName: organization.name,
    invitedEmail: maskEmail(invitation.email),
  };
}
