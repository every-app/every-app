import { logEvent } from "@every-app/perimeter";
import { createAuth } from "@/auth";
import { db } from "@/db";
import { invitations, members, users } from "@/db/schema";
import { and, count, eq, ne } from "drizzle-orm";
import { PublicError } from "@/server/errors";
import type { AdminUser } from "@/types/admin-user";
import { UserRepository } from "../repositories/UserRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { McpConnectionService } from "./McpConnectionService";
import { MembershipService } from "./MembershipService";
import { accessWouldLetBackIn } from "@/server/access-rejoin";
import { emit } from "@/server/events/bus";
import { catalogue, type EventUser } from "@/server/events/catalogue";
import { userActor, userSubject } from "@/server/events/subjects";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
import { mayDeleteMemberAccounts } from "@/server/tenant-user-actions";
import {
  forgetOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";

function invitationRow(invitation: any): AdminUser {
  const createdAt = new Date(invitation.createdAt ?? Date.now());
  const expiresAt =
    invitation.expiresAt === undefined || invitation.expiresAt === null
      ? undefined
      : new Date(invitation.expiresAt);
  return {
    id: `invitation:${String(invitation.id)}`,
    invitationId: String(invitation.id),
    name: String(invitation.email ?? "").split("@")[0] || "",
    email: String(invitation.email ?? ""),
    role: String(invitation.role ?? "member"),
    status: "pending",
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
    banned: null,
    ...(expiresAt && !Number.isNaN(expiresAt.getTime()) ? { expiresAt } : {}),
  };
}

async function hasOwner() {
  return { hasOwner: await hasAnyOwnerMembership() };
}

async function listMembers(ctx: OrgContext) {
  const [memberRows, pendingInvitations] = await Promise.all([
    OrganizationMembersRepository.listMembersForOrganization(ctx.orgId),
    db.query.invitations.findMany({
      columns: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        expiresAt: true,
      },
      where: and(
        eq(invitations.organizationId, ctx.orgId),
        eq(invitations.status, "pending"),
      ),
    }),
  ]);

  const invitationRows = pendingInvitations.map(invitationRow);

  const users: AdminUser[] = [...memberRows, ...invitationRows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  return { users };
}

/**
 * Remove a user from the organization (and delete the account when it
 * belongs to no other one). Their personal access tokens for this
 * organization are revoked in the same transaction, and the AI apps they
 * connected to it right after. (Deploying needs the Cloudflare login, which
 * the gateway can't revoke: see docs/security-model.md.)
 *
 * Who may be removed is the member-management rule
 * (MembershipService.requireManageableMember): never yourself, and an
 * owner only by another owner, never the last one. The writes refuse the
 * last live owner on their own too (wouldLeaveNoLiveOwner), for two owners
 * removing each other at once.
 *
 * Someone Cloudflare Access would let straight back in (an auto-join domain,
 * or everyone the outer ring admits) isn't kept out by deleting their
 * account: their next Access sign-in would make a new one and join again.
 * They are deactivated instead, and stay listed so they can be reactivated.
 *
 * Where the platform policy keeps accounts from tenant admins (the hosted
 * gateway) only the membership goes: the account is the person's own.
 */
async function deleteUser(
  ctx: OrgContext,
  targetUserId: string,
): Promise<{ deactivatedInstead: boolean }> {
  await MembershipService.requireManageableMember(ctx, targetUserId);

  const [otherMemberships] = await db
    .select({ value: count() })
    .from(members)
    .where(
      and(
        eq(members.userId, targetUserId),
        ne(members.organizationId, ctx.orgId),
      ),
    );
  const user = await UserRepository.findById(targetUserId);
  if (
    (otherMemberships?.value ?? 0) === 0 &&
    user &&
    accessWouldLetBackIn(user.email)
  ) {
    const deactivated = await UserRepository.deactivate(
      targetUserId,
      `Deleted by ${ctx.userId}; deactivated instead, as Cloudflare Access would let them back in`,
      { unlessLastOwnerOf: ctx.orgId },
    );
    if (!deactivated) throw MembershipService.lastOwnerRefusal();
    await McpConnectionService.revokeForDeactivatedUser(targetUserId);
    forgetOrgContext(targetUserId);
    logEvent("member.deactivated", {
      organizationId: ctx.orgId,
      userId: targetUserId,
      by: ctx.userId,
      reason: "deleted_with_access_auto_join",
    });
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.memberDeactivated({
        user: await userSubject(targetUserId),
        reason: "deleted_with_access_auto_join",
      }),
    }));
    return { deactivatedInstead: true };
  }

  // Read before the account may go, so the event still names the person;
  // a read that fails names the id alone rather than failing the removal.
  const subject = await userSubject(targetUserId).catch(
    (): EventUser => ({ id: targetUserId, email: null, name: null }),
  );
  const removed = await OrganizationMembersRepository.removeMember(
    targetUserId,
    ctx.orgId,
  );
  if (!removed) throw MembershipService.lastOwnerRefusal();
  await McpConnectionService.revokeForRemovedMember(targetUserId, ctx.orgId);
  forgetOrgContext(targetUserId);

  const [orgCountResult] = await db
    .select({ value: count() })
    .from(members)
    .where(eq(members.userId, targetUserId));

  const accountDeleted =
    (orgCountResult?.value ?? 0) === 0 && mayDeleteMemberAccounts();
  if (accountDeleted) {
    await db.delete(users).where(eq(users.id, targetUserId));
  }
  await emit(async () => ({
    organizationId: ctx.orgId,
    actor: await userActor(ctx.userId),
    ...catalogue.memberRemoved({ user: subject, accountDeleted }),
  }));
  return { deactivatedInstead: false };
}

async function cancelInvitation(
  ctx: OrgContext,
  invitationId: string,
  headers: Headers,
) {
  const invitation = await db.query.invitations.findFirst({
    columns: { id: true },
    where: and(
      eq(invitations.id, invitationId),
      eq(invitations.organizationId, ctx.orgId),
      eq(invitations.status, "pending"),
    ),
  });

  if (!invitation) {
    throw new Error("Pending invitation not found");
  }

  const auth = createAuth();
  await auth.api.cancelInvitation({
    headers,
    body: { invitationId },
  });

  return { success: true };
}

/**
 * Cancel a pending invitation without a browser session (the gateway's
 * own /mcp acts for a resolved caller, not a session): the same row Better
 * Auth's cancel writes, `status` canceled, for a pending invitation of
 * this organization alone.
 */
async function cancelInvitationWithoutSession(
  ctx: OrgContext,
  invitationId: string,
) {
  const canceled = await db
    .update(invitations)
    .set({ status: "canceled" })
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.organizationId, ctx.orgId),
        eq(invitations.status, "pending"),
      ),
    )
    .returning({ id: invitations.id, email: invitations.email });
  const invitation = canceled[0];
  if (!invitation) {
    throw new PublicError(
      "INVITATION_NOT_FOUND",
      "Pending invitation not found",
    );
  }
  logEvent("invitation.canceled", {
    organizationId: ctx.orgId,
    invitationId,
    by: ctx.userId,
  });
  return { success: true, invitation };
}

// TODO: Split this service once the org migration settles and review overhead drops.
export const AdminService = {
  hasOwner,
  listMembers,
  deleteUser,
  cancelInvitation,
  cancelInvitationWithoutSession,
} as const;
