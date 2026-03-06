import { env } from "cloudflare:workers";
import { createAuth } from "@/auth";
import { db } from "@/db";
import { invitations, members, users } from "@/db/schema";
import { and, count, eq } from "drizzle-orm";
import type { AdminUser } from "@/types/admin-user";
import { UserRepository } from "../repositories/UserRepository";
import { resolvePrimaryOrganizationRole } from "../org-roles";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
import { AppAccessService } from "./AppAccessService";

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
  let createdUserId: string | null = null;

  // We intentionally accept a tiny first-owner race window here to keep this
  // bootstrap flow simple. In practice this endpoint is called once during
  // setup, and we prefer readability over lock/lease complexity.
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

    throw error;
  }
}

async function listMembers(organizationId: string) {
  const [memberRows, pendingInvitations] = await Promise.all([
    OrganizationMembersRepository.listMembersForOrganization(organizationId),
    db.query.invitations.findMany({
      columns: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
      },
      where: and(
        eq(invitations.organizationId, organizationId),
        eq(invitations.status, "pending"),
      ),
    }),
  ]);

  const invitationRows = pendingInvitations.map(invitationRow);

  const users = [...memberRows, ...invitationRows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  return { users };
}

async function deleteUser(
  userId: string,
  currentUserId: string,
  organizationId: string | undefined,
) {
  if (userId === currentUserId) {
    throw new Error("Cannot delete your own account");
  }

  if (!organizationId) {
    throw new Error("Organization context is required");
  }

  const membership = await db.query.members.findFirst({
    columns: { id: true, role: true },
    where: and(
      eq(members.userId, userId),
      eq(members.organizationId, organizationId),
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
        eq(members.userId, userId),
        eq(members.organizationId, organizationId),
      ),
    );

  const [orgCountResult] = await db
    .select({ value: count() })
    .from(members)
    .where(eq(members.userId, userId));

  if ((orgCountResult?.value ?? 0) === 0) {
    await db.delete(users).where(eq(users.id, userId));
  }
}

async function sendPasswordResetEmail(userId: string, organizationId: string) {
  if (!organizationId) {
    throw new Error("Organization context is required");
  }

  const membership = await db.query.members.findFirst({
    columns: { id: true },
    where: and(
      eq(members.userId, userId),
      eq(members.organizationId, organizationId),
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
  sendPasswordResetEmail,
} as const;
