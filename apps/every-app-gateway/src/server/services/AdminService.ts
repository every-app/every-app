import { logEvent } from "@every-app/perimeter";
import { createAuth } from "@/auth";
import { db } from "@/db";
import { invitations, members, users } from "@/db/schema";
import { and, count, eq, ne } from "drizzle-orm";
import type { AdminUser } from "@/types/admin-user";
import { UserRepository } from "../repositories/UserRepository";
import { resolvePrimaryOrganizationRole } from "../org-roles";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { McpConnectionService } from "./McpConnectionService";
import { accessWouldLetBackIn } from "@/server/access-rejoin";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
import { mayDeleteMemberAccounts } from "@/server/tenant-user-actions";
import {
  forgetOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";

function invitationRow(invitation: any): AdminUser {
  const createdAt = new Date(invitation.createdAt ?? Date.now());
  return {
    id: `invitation:${String(invitation.id)}`,
    invitationId: String(invitation.id),
    name: String(invitation.email ?? "").split("@")[0] || "",
    email: String(invitation.email ?? ""),
    role: String(invitation.role ?? "member"),
    status: "pending",
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
    banned: null,
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
  if (targetUserId === ctx.userId) {
    throw new Error("Cannot delete your own account");
  }

  const membership = await db.query.members.findFirst({
    columns: { id: true, role: true },
    where: and(
      eq(members.userId, targetUserId),
      eq(members.organizationId, ctx.orgId),
    ),
  });

  if (!membership) {
    throw new Error("User not found");
  }

  const role = resolvePrimaryOrganizationRole(membership.role);

  if (role === "owner") {
    throw new Error("Cannot delete owner accounts");
  }

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
    await UserRepository.deactivate(
      targetUserId,
      `Deleted by ${ctx.userId}; deactivated instead, as Cloudflare Access would let them back in`,
    );
    await McpConnectionService.revokeForDeactivatedUser(targetUserId);
    forgetOrgContext(targetUserId);
    logEvent("member.deactivated", {
      organizationId: ctx.orgId,
      userId: targetUserId,
      by: ctx.userId,
      reason: "deleted_with_access_auto_join",
    });
    return { deactivatedInstead: true };
  }

  await OrganizationMembersRepository.removeMember(targetUserId, ctx.orgId);
  await McpConnectionService.revokeForRemovedMember(targetUserId, ctx.orgId);
  forgetOrgContext(targetUserId);

  const [orgCountResult] = await db
    .select({ value: count() })
    .from(members)
    .where(eq(members.userId, targetUserId));

  if ((orgCountResult?.value ?? 0) === 0 && mayDeleteMemberAccounts()) {
    await db.delete(users).where(eq(users.id, targetUserId));
  }
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

// TODO: Split this service once the org migration settles and review overhead drops.
export const AdminService = {
  hasOwner,
  listMembers,
  deleteUser,
  cancelInvitation,
} as const;
