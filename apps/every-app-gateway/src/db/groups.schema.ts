import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps.schema";
import { organizations, users } from "./auth.schema";

/**
 * Groups: named sets of an organization's members that apps are granted
 * to as one. A member opens an organization's own app when they hold a
 * `user_app_access` row for it or belong to a group holding a
 * `group_app_access` row for it (AppAccessRepository.effectiveAccess).
 * Shared apps are never granted to groups: they are everyone's already.
 */
export const groups = sqliteTable(
  "groups",
  {
    // "grp_" + 16 hex.
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Trimmed, 1..60 characters; unique in the organization, letter case
    // aside (the index below is on lower(name), so two admins creating
    // "Sales" and "sales" at once can't both succeed).
    name: text("name").notNull(),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("groups_organization_name_unique").on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
  ],
);

/**
 * Who is in a group: only live members of the group's organization (the
 * service checks; leaving the organization deletes the rows,
 * OrganizationMembersRepository.removeMember).
 */
export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    addedAt: integer("added_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    addedBy: text("added_by"),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index("group_members_organization_user_idx").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

/** The organization's own apps a group opens. */
export const groupAppAccess = sqliteTable(
  "group_app_access",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    appRowId: text("app_row_id").notNull(),
    organizationId: text("organization_id").notNull(),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    grantedBy: text("granted_by"),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.appRowId] }),
    foreignKey({
      columns: [table.appRowId, table.organizationId],
      foreignColumns: [apps.id, apps.organizationId],
      name: "group_app_access_app_row_org_fk",
    }).onDelete("cascade"),
    index("group_app_access_app_row_id_idx").on(table.appRowId),
  ],
);
