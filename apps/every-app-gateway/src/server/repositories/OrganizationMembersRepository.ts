import { db } from "@/db";
import {
  apps,
  groupMembers,
  members,
  organizations,
  userAccessTokens,
  userAppAccess,
  users,
} from "@/db/schema";
import {
  and,
  count,
  eq,
  exists,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { accessToApp } from "./effective-access";
import type { OrganizationMember } from "@every-app/sdk/internal";
import {
  resolvePrimaryOrganizationRole,
  type OrganizationRole,
} from "@/server/org-roles";

/**
 * The user isn't deactivated at `now`: isUserBanned (server/user-ban.ts) as
 * SQL, on `users` or an alias of it. Banned with no expiry, or an expiry
 * still to come, is deactivated.
 */
export function liveUser(
  now = new Date(),
  user: { banned: AnySQLiteColumn; banExpires: AnySQLiteColumn } = users,
): SQL {
  return or(
    isNull(user.banned),
    eq(user.banned, false),
    and(isNotNull(user.banExpires), lte(user.banExpires, now)),
  )!;
}

/**
 * The last-owner rule at the write: true when taking the user out of the
 * owner role (a demotion, a ban, a removal) would leave the organization
 * with no owner who can act: they hold an owner membership there, and no
 * other owner of it is live (an owner membership whose user isn't
 * deactivated). It goes in the WHERE of the write that would, so two
 * owners acting on each other at once can't both succeed: whichever write
 * runs second finds no other live owner and changes no rows. The services
 * read `countOwners` first for the friendlier early refusal; this is what
 * enforces it. A deactivated owner isn't counted as one who can act, and
 * taking the role off one is never refused while another owner is live.
 */
export function wouldLeaveNoLiveOwner(
  userId: string,
  organizationId: string,
  now = new Date(),
): SQL {
  const owners = alias(members, "owners");
  const ownerUsers = alias(users, "owner_users");
  const targetIsOwner = exists(
    db
      .select({ one: sql`1` })
      .from(owners)
      .where(
        and(
          eq(owners.userId, userId),
          eq(owners.organizationId, organizationId),
          eq(owners.role, "owner"),
        ),
      ),
  );
  const anotherLiveOwner = exists(
    db
      .select({ one: sql`1` })
      .from(owners)
      .innerJoin(ownerUsers, eq(ownerUsers.id, owners.userId))
      .where(
        and(
          eq(owners.organizationId, organizationId),
          eq(owners.role, "owner"),
          ne(owners.userId, userId),
          liveUser(now, ownerUsers),
        ),
      ),
  );
  return and(targetIsOwner, not(anotherLiveOwner))!;
}

/**
 * The members of an active organization who can open one of its apps now,
 * by the rule the perimeter applies when they visit it
 * (betterAuthAuthenticator.ts hasAppAccess): not deactivated, and granted
 * an organization's own app, directly or through a group
 * (effective-access.ts); a shared app opens for every member. The members
 * capability lists them for the app.
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
      .select({ id: apps.id })
      .from(apps)
      .where(
        and(
          eq(apps.organizationId, organizationId),
          eq(apps.appSlug, appSlug),
          accessToApp(users.id, organizationId),
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

/**
 * How many owner memberships the organization has, deactivated owners
 * included: the count the last-owner rule reads before a write
 * (MembershipService) for its early refusal; the write itself carries
 * `wouldLeaveNoLiveOwner`, which is what holds under concurrent writes.
 */
async function countOwners(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(members)
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.role, "owner"),
      ),
    );
  return row?.value ?? 0;
}

/**
 * Set a member's role. False when the row didn't change: no such
 * membership, or the role would have left the organization without an
 * owner who can act (wouldLeaveNoLiveOwner), which the statement itself
 * refuses.
 */
async function updateRole(
  userId: string,
  organizationId: string,
  role: OrganizationRole,
): Promise<boolean> {
  const changed = await db
    .update(members)
    .set({ role })
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, organizationId),
        role === "owner"
          ? undefined
          : not(wouldLeaveNoLiveOwner(userId, organizationId)),
      ),
    )
    .returning({ id: members.id });
  return changed.length > 0;
}

/**
 * Take a user out of an organization in one D1 transaction: the membership,
 * their app access there (direct, and their place in its groups), and the
 * personal access tokens they hold for it. Tokens act for the user, so
 * they go too. The membership's delete refuses an owner no other live
 * owner would outlast (wouldLeaveNoLiveOwner), and the rest applies only
 * once the membership is gone, so a refused removal changes nothing: false
 * then.
 * (The AI apps they connected are revoked after it, by
 * McpConnectionService.revokeForRemovedMember.)
 */
async function removeMember(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const now = new Date();
  const membershipGone = notExists(
    db
      .select({ one: sql`1` })
      .from(members)
      .where(
        and(
          eq(members.userId, userId),
          eq(members.organizationId, organizationId),
        ),
      ),
  );
  const [removed] = await db.batch([
    db
      .delete(members)
      .where(
        and(
          eq(members.userId, userId),
          eq(members.organizationId, organizationId),
          not(wouldLeaveNoLiveOwner(userId, organizationId, now)),
        ),
      )
      .returning({ id: members.id }),
    db
      .delete(userAppAccess)
      .where(
        and(
          eq(userAppAccess.userId, userId),
          eq(userAppAccess.organizationId, organizationId),
          membershipGone,
        ),
      ),
    db
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.userId, userId),
          eq(groupMembers.organizationId, organizationId),
          membershipGone,
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
          membershipGone,
        ),
      ),
  ]);
  return removed.length > 0;
}

export const OrganizationMembersRepository = {
  listMembersForOrganization,
  listAppMembers,
  findMembership,
  findMembershipWithUser,
  countOwners,
  updateRole,
  removeMember,
} as const;
