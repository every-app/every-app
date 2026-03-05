import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { organizations, users } from "./auth.schema";

/**
 * Organization app catalog - managed per organization
 */
export const apps = sqliteTable(
  "apps",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id").notNull(), // e.g., "todo-app"
    name: text("name").notNull(),
    description: text("description").notNull(),
    appUrl: text("app_url").notNull(),
    devUrl: text("dev_url"),
    isDefault: integer("is_default", { mode: "boolean" })
      .default(false)
      .notNull(), // Auto-grant to new users within organization
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("apps_organization_app_id_unique").on(
      table.organizationId,
      table.appId,
    ),
    index("apps_organization_id_idx").on(table.organizationId),
  ],
);

/**
 * Junction table for user app access - controls which users can access which apps
 */
export const userAppAccess = sqliteTable(
  "user_app_access",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    grantedBy: text("granted_by").references(() => users.id, {
      onDelete: "set null",
    }), // Which owner granted access (null for system/migration)
  },
  (table) => [
    uniqueIndex("user_app_access_user_app_unique").on(
      table.organizationId,
      table.userId,
      table.appId,
    ),
    index("user_app_access_organization_id_idx").on(table.organizationId),
    index("user_app_access_user_id_idx").on(table.userId),
    index("user_app_access_app_id_idx").on(table.appId),
  ],
);

/**
 * Machine-to-machine app tokens for gateway access.
 * Tokens are stored as irreversible hashes; plaintext is never persisted.
 */
export const appTokens = sqliteTable(
  "app_tokens",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("app_tokens_token_hash_unique").on(table.tokenHash),
    index("app_tokens_organization_id_idx").on(table.organizationId),
    index("app_tokens_app_id_idx").on(table.appId),
    index("app_tokens_token_prefix_idx").on(table.tokenPrefix),
    index("app_tokens_revoked_at_idx").on(table.revokedAt),
  ],
);

// Relations
export const appsRelations = relations(apps, ({ many }) => ({
  userAccess: many(userAppAccess),
  appTokens: many(appTokens),
}));

export const userAppAccessRelations = relations(userAppAccess, ({ one }) => ({
  user: one(users, {
    fields: [userAppAccess.userId],
    references: [users.id],
  }),
  app: one(apps, {
    fields: [userAppAccess.appId],
    references: [apps.id],
  }),
  grantedByUser: one(users, {
    fields: [userAppAccess.grantedBy],
    references: [users.id],
  }),
}));

export const appTokensRelations = relations(appTokens, ({ one }) => ({
  app: one(apps, {
    fields: [appTokens.appId],
    references: [apps.id],
  }),
  createdByUser: one(users, {
    fields: [appTokens.createdBy],
    references: [users.id],
  }),
}));
