import { db } from "@/db";
import { apps, groupAppAccess, groupMembers, userAppAccess } from "@/db/schema";
import { and, eq, exists, sql, type AnyColumn } from "drizzle-orm";

/**
 * The one access rule, as a subquery: who opens which of an organization's
 * own apps. A row per (user, app) grant, direct (`user_app_access`,
 * `groupId` null) or through a group they belong to that holds the app
 * (`group_members` x `group_app_access`). Every site that decides or shows
 * access reads this, so direct and group grants can never disagree: the
 * perimeter, the launcher, the admin modal, the members capability, the
 * MCP catalogs and the access counts. A user with both kinds of grant has
 * several rows; callers that list dedupe, callers that decide use
 * {@link accessToApp}.
 */
export function effectiveAccess(organizationId: string) {
  return db
    .select({
      userId: userAppAccess.userId,
      appRowId: userAppAccess.appRowId,
      grantedAt: userAppAccess.grantedAt,
      groupId: sql<string | null>`NULL`.as("group_id"),
    })
    .from(userAppAccess)
    .where(eq(userAppAccess.organizationId, organizationId))
    .unionAll(
      db
        .select({
          userId: groupMembers.userId,
          appRowId: groupAppAccess.appRowId,
          grantedAt: groupAppAccess.grantedAt,
          groupId: sql<string | null>`${groupAppAccess.groupId}`.as("group_id"),
        })
        .from(groupMembers)
        .innerJoin(
          groupAppAccess,
          eq(groupAppAccess.groupId, groupMembers.groupId),
        )
        .where(
          and(
            eq(groupMembers.organizationId, organizationId),
            eq(groupAppAccess.organizationId, organizationId),
          ),
        ),
    )
    .as("effective_access");
}

/**
 * `EXISTS`: the user (an id, or a column of the enclosing query such as
 * `users.id`) holds some grant to the `apps` row of the enclosing query, in
 * this organization. For `WHERE` clauses over `apps`: one condition, no
 * join, so a user granted twice never doubles a row.
 */
export function accessToApp(
  userId: string | AnyColumn,
  organizationId: string,
) {
  const access = effectiveAccess(organizationId);
  return exists(
    db
      .select({ one: sql`1` })
      .from(access)
      .where(and(eq(access.userId, userId), eq(access.appRowId, apps.id))),
  );
}

/** `EXISTS`: anyone holds a grant to the enclosing query's `apps` row. */
export function anyAccessToApp(organizationId: string) {
  const access = effectiveAccess(organizationId);
  return exists(
    db
      .select({ one: sql`1` })
      .from(access)
      .where(eq(access.appRowId, apps.id)),
  );
}

/**
 * `EXISTS`: the user holds some grant, direct or through a group, to the
 * enclosing query's `apps` row, in that row's organization. For the one
 * query that spans the user's organizations (the AI-connection consent
 * page, {@link McpConnectionRepository.listChoicesForUser}); a query over
 * one organization uses {@link accessToApp}.
 */
export function accessToAppInItsOrganization(userId: string) {
  const grants = db
    .select({
      organizationId: userAppAccess.organizationId,
      appRowId: userAppAccess.appRowId,
    })
    .from(userAppAccess)
    .where(eq(userAppAccess.userId, userId))
    .unionAll(
      db
        .select({
          organizationId: groupAppAccess.organizationId,
          appRowId: groupAppAccess.appRowId,
        })
        .from(groupMembers)
        .innerJoin(
          groupAppAccess,
          and(
            eq(groupAppAccess.groupId, groupMembers.groupId),
            eq(groupAppAccess.organizationId, groupMembers.organizationId),
          ),
        )
        .where(eq(groupMembers.userId, userId)),
    )
    .as("user_grants");
  return exists(
    db
      .select({ one: sql`1` })
      .from(grants)
      .where(
        and(
          eq(grants.appRowId, apps.id),
          eq(grants.organizationId, apps.organizationId),
        ),
      ),
  );
}
