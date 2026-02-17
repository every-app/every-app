import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Global app catalog - centrally managed by owners
 */
export const apps = sqliteTable("apps", {
  id: text("id").primaryKey(),
  appId: text("app_id").notNull().unique(), // e.g., "todo-app" - unique() creates an index
  name: text("name").notNull(),
  description: text("description").notNull(),
  appUrl: text("app_url").notNull(),
  devUrl: text("dev_url"),
  isDefault: integer("is_default", { mode: "boolean" })
    .default(false)
    .notNull(), // Auto-grant to new users
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

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
    grantedAt: integer("granted_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    grantedBy: text("granted_by").references(() => users.id, {
      onDelete: "set null",
    }), // Which owner granted access (null for system/migration)
  },
  (table) => [
    uniqueIndex("user_app_access_user_app_unique").on(
      table.userId,
      table.appId,
    ),
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
