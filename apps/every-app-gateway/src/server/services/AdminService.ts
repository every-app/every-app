import { env } from "cloudflare:workers";
import { createAuth } from "@/auth";
import { db } from "@/db";
import { invitations, members, users } from "@/db/schema";
import { and, count, eq } from "drizzle-orm";
import type { AdminUser } from "@/types/admin-user";
import { UserRepository } from "../repositories/UserRepository";
import { resolvePrimaryOrganizationRole } from "../org-roles";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { McpConnectionService } from "./McpConnectionService";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
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
 * belongs to no other one). Their deploy tokens and personal access tokens
 * for this organization are revoked in the same transaction, and the AI apps
 * they connected to it right after.
 */
async function deleteUser(ctx: OrgContext, targetUserId: string) {
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

  await OrganizationMembersRepository.removeMember(targetUserId, ctx.orgId);
  await McpConnectionService.revokeForRemovedMember(targetUserId, ctx.orgId);
  forgetOrgContext(targetUserId);

  const [orgCountResult] = await db
    .select({ value: count() })
    .from(members)
    .where(eq(members.userId, targetUserId));

  if ((orgCountResult?.value ?? 0) === 0) {
    await db.delete(users).where(eq(users.id, targetUserId));
  }
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

async function sendPasswordResetEmail(ctx: OrgContext, userId: string) {
  const membership = await db.query.members.findFirst({
    columns: { id: true },
    where: and(
      eq(members.userId, userId),
      eq(members.organizationId, ctx.orgId),
    ),
  });

  if (!membership) {
    throw new Error("User not found");
  }

  const user = await UserRepository.findById(userId);

  if (!user) {
    throw new Error("User not found");
  }

  if (user.status !== "active") {
    throw new Error("Can only send password reset emails for active users");
  }

  const auth = createAuth();
  await auth.api.requestPasswordReset({
    body: {
      email: user.email,
      redirectTo: `${env.GATEWAY_URL}/reset-password`,
    },
  });

  return { success: true };
}

// TODO: Split this service once the org migration settles and review overhead drops.
export const AdminService = {
  hasOwner,
  listMembers,
  deleteUser,
  cancelInvitation,
  sendPasswordResetEmail,
} as const;
