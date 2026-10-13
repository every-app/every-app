import { db } from "@/db";
import {
  appTokens,
  members,
  organizations,
  userAccessTokens,
  userAppAccess,
  users,
} from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { OrganizationRole } from "@/server/org-roles";

async function listMembersForOrganization(organizationId: string) {
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: members.role,
      status: users.status,
      createdAt: users.createdAt,
      banned: users.banned,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.organizationId, organizationId));
}

/** The organization `userId` owns (the claim's owner owns exactly one). */
async function findOwnedOrganizationId(userId: string): Promise<string | null> {
  const row = await db.query.members.findFirst({
    columns: { organizationId: true },
    where: and(eq(members.userId, userId), eq(members.role, "owner")),
  });
  return row?.organizationId ?? null;
}

async function findMembership(userId: string, organizationId: string) {
  return db.query.members.findFirst({
    columns: { id: true, role: true },
    where: and(
      eq(members.userId, userId),
      eq(members.organizationId, organizationId),
    ),
  });
}

/**
 * A membership with what a credential acting for the user re-checks on
 * every request: the role, the user's ban state and email, and the
 * organization's name. Null once the user left the organization.
 */
async function findMembershipWithUser(userId: string, organizationId: string) {
  const [row] = await db
    .select({
      role: members.role,
      email: users.email,
      banned: users.banned,
      banExpires: users.banExpires,
      organizationName: organizations.name,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function updateRole(
  userId: string,
  organizationId: string,
  role: Exclude<OrganizationRole, "owner">,
): Promise<void> {
  await db
    .update(members)
    .set({ role })
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, organizationId),
      ),
    );
}

/**
 * Take a user out of an organization in one D1 transaction: the membership,
 * their app access there, and the deploy tokens they created and personal
 * access tokens they hold for it. Tokens act for the user, so they go too.
 * (The AI apps they connected are revoked after it, by
 * McpConnectionService.revokeForRemovedMember.)
 */
async function removeMember(
  userId: string,
  organizationId: string,
): Promise<void> {
  const now = new Date();
  await db.batch([
    db
      .delete(members)
      .where(
        and(
          eq(members.userId, userId),
          eq(members.organizationId, organizationId),
        ),
      ),
    db
      .delete(userAppAccess)
      .where(
        and(
          eq(userAppAccess.userId, userId),
          eq(userAppAccess.organizationId, organizationId),
        ),
      ),
    db
      .update(appTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(appTokens.createdBy, userId),
          eq(appTokens.organizationId, organizationId),
          isNull(appTokens.revokedAt),
        ),
      ),
    db
      .update(userAccessTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(userAccessTokens.userId, userId),
          eq(userAccessTokens.organizationId, organizationId),
          isNull(userAccessTokens.revokedAt),
        ),
      ),
  ]);
}

export const OrganizationMembersRepository = {
  findOwnedOrganizationId,
  listMembersForOrganization,
  findMembership,
  findMembershipWithUser,
  updateRole,
  removeMember,
} as const;
