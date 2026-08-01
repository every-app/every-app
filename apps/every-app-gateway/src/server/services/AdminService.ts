import { env } from "cloudflare:workers";
import { createAuth } from "@/auth";
import { db } from "@/db";
import { invitations, members, users } from "@/db/schema";
import { and, count, eq } from "drizzle-orm";
import type { AdminUser } from "@/types/admin-user";
import { UserRepository } from "../repositories/UserRepository";
import { resolvePrimaryOrganizationRole } from "../org-roles";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import {
  claimOwnerBootstrap,
  hasAnyOwnerMembership,
  releaseOwnerBootstrap,
} from "@/server/organization/owner-membership";
import { AppAccessService } from "./AppAccessService";
import type { OrgContext } from "@/server/organization/orgContext";

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

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

async function initializeOwner(email: string, password: string) {
  const { hasOwner: alreadyHasOwner } = await hasOwner();
  if (alreadyHasOwner) {
    throw new Error("Owner already exists. Registration is invite-only.");
  }

  const auth = createAuth();
  const claimedBootstrap = await claimOwnerBootstrap();

  if (!claimedBootstrap) {
    throw new Error("Owner already exists. Registration is invite-only.");
  }

  let createdUserId: string | null = null;

  // The singleton bootstrap claim is inserted atomically before Better Auth
  // creates any records, so only one concurrent request can reach this flow.
  try {
    const result = await auth.api.signUpEmail({
      body: {
        name: "",
        email,
        password,
      },
    });

    if (!result.user) {
      throw new Error("Failed to create owner account");
    }

    createdUserId = result.user.id;

    const slug =
      slugify(result.user.name || "") ||
      slugify(email.split("@")[0] || "org") ||
      "org";

    const organization = await auth.api.createOrganization({
      body: {
        name: result.user.name?.trim() || "My Organization",
        slug,
        userId: result.user.id,
      },
    });

    if (!organization) {
      throw new Error("Failed to create organization");
    }

    await AppAccessService.grantDefaultAppsToUser(
      result.user.id,
      organization.id,
    );

    return { userId: result.user.id, organizationId: organization.id };
  } catch (error) {
    if (createdUserId) {
      await auth.api.removeUser({
        body: {
          userId: createdUserId,
        },
      });
    }

    await releaseOwnerBootstrap();
    throw error;
  }
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

  await db
    .delete(members)
    .where(
      and(
        eq(members.userId, targetUserId),
        eq(members.organizationId, ctx.orgId),
      ),
    );

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
  initializeOwner,
  listMembers,
  deleteUser,
  cancelInvitation,
  sendPasswordResetEmail,
} as const;
