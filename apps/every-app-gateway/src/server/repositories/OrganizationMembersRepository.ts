import { db } from "@/db";
import {
  appTokens,
  members,
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

async function findMembership(userId: string, organizationId: string) {
  return db.query.members.findFirst({
    columns: { id: true, role: true },
    where: and(
      eq(members.userId, userId),
      eq(members.organizationId, organizationId),
    ),
  });
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
  listMembersForOrganization,
  findMembership,
  updateRole,
  removeMember,
} as const;
