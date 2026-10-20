import { db } from "@/db";
import {
  apps,
  members,
  organizations,
  userAccessTokens,
  userAppAccess,
  users,
} from "@/db/schema";
import {
  and,
  eq,
  exists,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { OrganizationMember } from "@every-app/sdk/internal";
import {
  resolvePrimaryOrganizationRole,
  type OrganizationRole,
} from "@/server/org-roles";

/**
 * The user isn't deactivated at `now`: isUserBanned (server/user-ban.ts) as
 * SQL. Banned with no expiry, or an expiry still to come, is deactivated.
 */
export function liveUser(now = new Date()): SQL {
  return or(
    isNull(users.banned),
    eq(users.banned, false),
    and(isNotNull(users.banExpires), lte(users.banExpires, now)),
  )!;
}

/**
 * The members of an active organization who can open one of its apps now,
 * by the rule the perimeter applies when they visit it
 * (betterAuthAuthenticator.ts hasAppAccess): not deactivated, and granted
 * an organization's own app (`user_app_access`); a shared app opens for
 * every member. The members capability lists them for the app.
 */
async function listAppMembers({
  organizationId,
  appSlug,
  shared,
}: {
  organizationId: string;
  appSlug: string;
  shared: boolean;
}): Promise<OrganizationMember[]> {
  const granted = exists(
    db
      .select({ id: userAppAccess.id })
      .from(userAppAccess)
      .innerJoin(apps, eq(userAppAccess.appRowId, apps.id))
      .where(
        and(
          eq(userAppAccess.userId, users.id),
          eq(userAppAccess.organizationId, organizationId),
          eq(apps.organizationId, organizationId),
          eq(apps.appSlug, appSlug),
        ),
      ),
  );
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: members.role,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(organizations.status, "active"),
        liveUser(),
        ...(shared ? [] : [granted]),
      ),
    );
  return rows.flatMap((row) => {
    const role = resolvePrimaryOrganizationRole(row.role);
    return role
      ? [{ id: row.id, email: row.email, name: row.name ?? "", role }]
      : [];
  });
}

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
      organizationStatus: organizations.status,
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
 * their app access there, and the personal access tokens they hold for it.
 * Tokens act for the user, so they go too.
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
  listAppMembers,
  findMembership,
  findMembershipWithUser,
  updateRole,
  removeMember,
} as const;
