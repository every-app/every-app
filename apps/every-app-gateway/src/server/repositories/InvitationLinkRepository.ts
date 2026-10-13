import { db } from "@/db";
import { invitationLinkTokens, invitations } from "@/db/schema";
import { eq } from "drizzle-orm";

/** Store an invite link's token hash for one invitation. */
async function create(invitationId: string, tokenHash: string): Promise<void> {
  await db.insert(invitationLinkTokens).values({
    id: crypto.randomUUID(),
    invitationId,
    tokenHash,
  });
}

/** The invitation an invite link was made for, whatever its state. */
async function findInvitationByTokenHash(tokenHash: string) {
  const [invitation] = await db
    .select({
      id: invitations.id,
      organizationId: invitations.organizationId,
      email: invitations.email,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
    })
    .from(invitationLinkTokens)
    .innerJoin(
      invitations,
      eq(invitationLinkTokens.invitationId, invitations.id),
    )
    .where(eq(invitationLinkTokens.tokenHash, tokenHash))
    .limit(1);
  return invitation ?? null;
}

/** Drop every link to an invitation (it was used). */
async function deleteForInvitation(invitationId: string): Promise<void> {
  await db
    .delete(invitationLinkTokens)
    .where(eq(invitationLinkTokens.invitationId, invitationId));
}

export const InvitationLinkRepository = {
  create,
  findInvitationByTokenHash,
  deleteForInvitation,
} as const;
