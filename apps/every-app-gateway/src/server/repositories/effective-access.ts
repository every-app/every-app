import { db } from "@/db";
import {
  apps,
  groupAppAccess,
  groupMembers,
  members,
  userAppAccess,
} from "@/db/schema";
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import {
  and,
  eq,
  exists,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

/**
 * The one access rule: who opens which of an organization's own apps. A
 * member of the app's organization opens it when
 *
 *   - the app is available to everyone (`apps.everyone`), or
 *   - they are an owner or admin there, or
 *   - they hold a person's grant (`user_app_access`), or
 *   - they belong to a group holding the app (`group_members` x
 *     `group_app_access`).
 *
 * Every site that decides or shows access reads this file, so the four
 * ways can never disagree: the perimeter, the launcher, the admin modal,
 * the members capability, the MCP catalogs, the consent page, OAuth's
 * "may use the app" check and the access counts. A shared app (the hosted
 * gateway's) is decided apart: every member of every organization opens it.
 */

/** How someone opens an app, as {@link effectiveAccess} lists it. */
type AccessVia = "everyone" | "admin" | "direct" | "group";

/** SQL: the `members.role` value (one role, or several comma-separated) holds owner or admin. */
function isOwnerOrAdminRole(role: AnyColumn): SQL {
  const list = sql`(',' || replace(${role}, ' ', '') || ',')`;
  return sql`(${list} LIKE '%,owner,%' OR ${list} LIKE '%,admin,%')`;
}

/**
 * A row per (user, app) way in, for an organization: `via` says which way,
 * and `groupId` names the group for a group grant. A user with several ways
 * in has several rows; callers that list dedupe, callers that decide use
 * {@link accessToApp}. The `everyone` and `admin` rows cover the
 * organization's live apps only (a tombstone opens for nobody).
 */
export function effectiveAccess(organizationId: string) {
  const admin = isOwnerOrAdminRole(members.role);
  return db
    .select({
      userId: members.userId,
      appRowId: sql<string>`${apps.id}`.as("app_row_id"),
      // When they could first open it: they joined, or it was registered.
      grantedAt: sql<Date>`max(${members.createdAt}, ${apps.createdAt})`
        .mapWith(apps.createdAt)
        .as("granted_at"),
      groupId: sql<string | null>`NULL`.as("group_id"),
      via: sql<AccessVia>`CASE WHEN ${admin} THEN 'admin' ELSE 'everyone' END`.as(
        "via",
      ),
    })
    .from(members)
    .innerJoin(
      apps,
      and(
        eq(apps.organizationId, members.organizationId),
        ne(apps.status, DELETED_APP_STATUS),
        or(eq(apps.everyone, true), admin),
      ),
    )
    .where(eq(members.organizationId, organizationId))
    .unionAll(
      db
        .select({
          userId: userAppAccess.userId,
          appRowId: userAppAccess.appRowId,
          grantedAt: userAppAccess.grantedAt,
          groupId: sql<string | null>`NULL`.as("group_id"),
          via: sql<AccessVia>`'direct'`.as("via"),
        })
        .from(userAppAccess)
        .where(eq(userAppAccess.organizationId, organizationId)),
    )
    .unionAll(
      db
        .select({
          userId: groupMembers.userId,
          appRowId: groupAppAccess.appRowId,
          grantedAt: groupAppAccess.grantedAt,
          groupId: sql<string | null>`${groupAppAccess.groupId}`.as("group_id"),
          via: sql<AccessVia>`'group'`.as("via"),
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
 * The rule as a condition on the `apps` row of the enclosing query, in that
 * row's organization: the user (an id, or a column of the enclosing query
 * such as `users.id`) opens it. For the one query that spans the user's
 * organizations (the AI-connection consent page,
 * McpConnectionRepository.listChoicesForUser); a query over one
 * organization uses {@link accessToApp}.
 */
export function accessToAppInItsOrganization(userId: string | AnyColumn) {
  return or(
    exists(
      db
        .select({ one: sql`1` })
        .from(members)
        .where(
          and(
            eq(members.userId, userId),
            eq(members.organizationId, apps.organizationId),
            ne(apps.status, DELETED_APP_STATUS),
            or(eq(apps.everyone, true), isOwnerOrAdminRole(members.role)),
          ),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(userAppAccess)
        .where(
          and(
            eq(userAppAccess.userId, userId),
            eq(userAppAccess.appRowId, apps.id),
            eq(userAppAccess.organizationId, apps.organizationId),
          ),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(groupMembers)
        .innerJoin(
          groupAppAccess,
          and(
            eq(groupAppAccess.groupId, groupMembers.groupId),
            eq(groupAppAccess.organizationId, groupMembers.organizationId),
          ),
        )
        .where(
          and(
            eq(groupMembers.userId, userId),
            eq(groupAppAccess.appRowId, apps.id),
            eq(groupAppAccess.organizationId, apps.organizationId),
          ),
        ),
    ),
  )!;
}

/**
 * The rule as a condition on the `apps` row of the enclosing query: the row
 * is this organization's, and the user opens it. One condition for `WHERE`
 * clauses over `apps`, no join, so a user let in several ways never doubles
 * a row.
 */
export function accessToApp(
  userId: string | AnyColumn,
  organizationId: string,
) {
  return and(
    eq(apps.organizationId, organizationId),
    accessToAppInItsOrganization(userId),
  )!;
}
