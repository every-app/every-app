/**
 * What an owner or admin issues outlives them unless something ends it: a
 * pending invitation (72 hours) joins someone, an admin-minted reset link
 * (one hour) hands over an account. Both end with the issuer's authority:
 * cancelled when the issuer is removed from the organization, deactivated
 * or demoted below admin (MembershipService, AdminService), and re-checked
 * against the issuer's live role at the moment they are used (an invite
 * link opened, sign-up through it, Access or a sign-in provider accepting a
 * pending invitation for a verified email; Better Auth's /reset-password
 * consuming an admin's token). docs/threat-model.md gap 12.
 *
 * Admin-minted reset tokens are Better Auth verification rows
 * (`reset-password:<token>`, value the user id) so the regular reset page
 * consumes them; who issued one is a companion row beside it
 * (`admin-reset-password:<token>`, value `{ issuerId, organizationId,
 * userId }`) with the same expiry. A reset a person requested themselves
 * has no companion row and is never touched here.
 */
import { and, eq, like } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { logEvent } from "@every-app/perimeter";
import { db } from "@/db";
import {
  invitationLinkTokens,
  invitations,
  members,
  users,
  verifications,
} from "@/db/schema";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import type { EventActor } from "@/server/events/catalogue";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import { isUserBanned } from "@/server/user-ban";

const ADMIN_RESET_PREFIX = "admin-reset-password:";
const RESET_PREFIX = "reset-password:";

/** Who issued what, and where: the scope a revocation acts on. */
interface Issuer {
  userId: string;
  /** Only this organization's; omitted (deactivation) means every organization's. */
  organizationId?: string;
}

/**
 * Whether the person who issued something is still an owner or admin of
 * that organization and not deactivated. A missing membership or user
 * answers false: whatever they issued is no longer backed by anyone.
 */
async function issuerStillAuthorized(
  issuerId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      role: members.role,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.userId, issuerId),
        eq(members.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return false;
  if (isUserBanned(row)) return false;
  const role = resolvePrimaryOrganizationRole(row.role);
  return role === "owner" || role === "admin";
}

type CancelledInvitation = {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
};

/**
 * Cancel pending invitations: status `canceled` (what Better Auth's cancel
 * writes, so the UI lists them as such) and every link token deleted, so no
 * link for them signs anyone up or in again. Returns what was cancelled.
 */
async function cancelInvitations(
  where: Parameters<typeof and>[number],
): Promise<CancelledInvitation[]> {
  const cancelled = await db
    .update(invitations)
    .set({ status: "canceled" })
    .where(and(eq(invitations.status, "pending"), where))
    .returning({
      id: invitations.id,
      organizationId: invitations.organizationId,
      email: invitations.email,
      role: invitations.role,
    });
  for (const invitation of cancelled) {
    await db
      .delete(invitationLinkTokens)
      .where(eq(invitationLinkTokens.invitationId, invitation.id));
  }
  return cancelled;
}

async function announceCancelled(
  cancelled: CancelledInvitation[],
  actor: EventActor,
  reason: string,
): Promise<void> {
  for (const invitation of cancelled) {
    logEvent("invitation.canceled", {
      organizationId: invitation.organizationId,
      invitationId: invitation.id,
      reason,
    });
    await emit({
      organizationId: invitation.organizationId,
      actor,
      ...catalogue.memberInvitationCancelled({
        invitation: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role ?? "member",
        },
      }),
    });
  }
}

/**
 * Cancel every pending invitation the issuer sent (in one organization, or
 * everywhere when they were deactivated). `actor` is who caused it, for the
 * `member.invitation_cancelled` events.
 */
export async function cancelInvitationsIssuedBy(
  issuer: Issuer,
  actor: EventActor,
  reason: "issuer_removed" | "issuer_deactivated" | "issuer_demoted",
): Promise<number> {
  const cancelled = await cancelInvitations(
    and(
      eq(invitations.inviterId, issuer.userId),
      issuer.organizationId
        ? eq(invitations.organizationId, issuer.organizationId)
        : undefined,
    ),
  );
  await announceCancelled(cancelled, actor, reason);
  return cancelled.length;
}

/**
 * The live check at use: a pending invitation whose inviter is no longer an
 * owner or admin of its organization (or is deactivated) is cancelled on
 * the spot and answers false; every path that would honour it
 * (findPendingInvitationByToken, acceptPendingInvitations) then treats it
 * as no invitation.
 */
export async function invitationIssuerStillAuthorized(invitation: {
  id: string;
  organizationId: string;
  inviterId: string | null;
}): Promise<boolean> {
  if (
    invitation.inviterId &&
    (await issuerStillAuthorized(
      invitation.inviterId,
      invitation.organizationId,
    ))
  ) {
    return true;
  }
  const cancelled = await cancelInvitations(eq(invitations.id, invitation.id));
  await announceCancelled(cancelled, { kind: "gateway" }, "issuer_revoked");
  return false;
}

/** Remember who minted an admin reset token, beside Better Auth's own row. */
export async function recordAdminResetToken(input: {
  token: string;
  userId: string;
  issuerId: string;
  organizationId: string;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(verifications).values({
    id: crypto.randomUUID(),
    identifier: `${ADMIN_RESET_PREFIX}${input.token}`,
    value: JSON.stringify({
      issuerId: input.issuerId,
      organizationId: input.organizationId,
      userId: input.userId,
    }),
    expiresAt: input.expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

type AdminResetRecord = {
  issuerId: string;
  organizationId: string;
  userId: string;
};

function parseRecord(value: string): AdminResetRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as AdminResetRecord).issuerId === "string" &&
      typeof (parsed as AdminResetRecord).organizationId === "string" &&
      typeof (parsed as AdminResetRecord).userId === "string"
    ) {
      return parsed as AdminResetRecord;
    }
  } catch {
    // Not ours.
  }
  return null;
}

/** Delete an admin reset token: Better Auth's row and the companion. */
async function deleteAdminResetToken(token: string): Promise<void> {
  await db
    .delete(verifications)
    .where(eq(verifications.identifier, `${RESET_PREFIX}${token}`));
  await db
    .delete(verifications)
    .where(eq(verifications.identifier, `${ADMIN_RESET_PREFIX}${token}`));
}

/**
 * Delete every outstanding reset token the issuer minted (in one
 * organization, or everywhere when they were deactivated). Tokens people
 * requested for themselves are untouched.
 */
export async function revokeAdminResetTokensIssuedBy(
  issuer: Issuer,
): Promise<number> {
  const rows = await db
    .select({
      identifier: verifications.identifier,
      value: verifications.value,
    })
    .from(verifications)
    .where(like(verifications.identifier, `${ADMIN_RESET_PREFIX}%`));
  let revoked = 0;
  for (const row of rows) {
    const record = parseRecord(row.value);
    if (!record || record.issuerId !== issuer.userId) continue;
    if (
      issuer.organizationId &&
      record.organizationId !== issuer.organizationId
    )
      continue;
    await deleteAdminResetToken(
      row.identifier.slice(ADMIN_RESET_PREFIX.length),
    );
    revoked += 1;
  }
  if (revoked > 0) {
    logEvent("member.reset_links_revoked", {
      issuerId: issuer.userId,
      organizationId: issuer.organizationId ?? null,
      count: revoked,
    });
  }
  return revoked;
}

/**
 * After Better Auth answered /reset-password: once its own row is gone
 * (consumed), the companion goes too. A refused reset (a short password)
 * keeps both, so the link still works as it should.
 */
export async function releaseAdminResetToken(token: unknown): Promise<void> {
  if (typeof token !== "string" || token.length === 0) return;
  const [live] = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(eq(verifications.identifier, `${RESET_PREFIX}${token}`))
    .limit(1);
  if (live) return;
  await db
    .delete(verifications)
    .where(eq(verifications.identifier, `${ADMIN_RESET_PREFIX}${token}`));
}

/**
 * Before Better Auth consumes a reset token: an admin-minted one whose
 * issuer is no longer an owner or admin of the organization it was minted
 * in (or is deactivated) is deleted and refused, with the same answer an
 * expired token gets. A token with no companion row (a reset the person
 * asked for) passes; Better Auth checks it.
 */
export async function requireAdminResetTokenIssuer(
  token: unknown,
): Promise<void> {
  if (typeof token !== "string" || token.length === 0) return;
  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(eq(verifications.identifier, `${ADMIN_RESET_PREFIX}${token}`))
    .limit(1);
  if (!row) return;
  const record = parseRecord(row.value);
  if (
    record &&
    (await issuerStillAuthorized(record.issuerId, record.organizationId))
  ) {
    return;
  }
  await deleteAdminResetToken(token);
  logEvent("member.reset_link_refused", {
    organizationId: record?.organizationId ?? null,
    userId: record?.userId ?? null,
    reason: "issuer_revoked",
  });
  throw new APIError("BAD_REQUEST", {
    code: "INVALID_TOKEN",
    message: "Invalid token",
  });
}
