import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  foreignKey,
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
    appSlug: text("app_slug").notNull(), // e.g., "todo-app"
    name: text("name").notNull(),
    description: text("description").notNull(),
    // --- perimeter routing + policy registry columns ---
    // Full routing hostname, e.g. "todo-acme.example.com" (unique per gateway).
    hostname: text("hostname").unique(),
    // Service-binding / script name, e.g. "every-todo-app". Unique per
    // gateway: worker names share one Cloudflare-account namespace, and
    // D1/KV resource names derive from them.
    workerName: text("worker_name").unique(),
    // 'service_binding' now; 'dispatch' reserved for the hosted tier.
    tier: text("tier").notNull().default("service_binding"),
    // JSON snapshot of everyapp.config.ts taken at deploy time.
    manifest: text("manifest"),
    // 'active' | 'disabled' | 'deploying'
    status: text("status").notNull().default("active"),
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
    uniqueIndex("apps_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("apps_organization_app_slug_unique").on(
      table.organizationId,
      table.appSlug,
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
    appRowId: text("app_row_id")
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
    foreignKey({
      columns: [table.appRowId, table.organizationId],
      foreignColumns: [apps.id, apps.organizationId],
      name: "user_app_access_app_row_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("user_app_access_user_app_unique").on(
      table.organizationId,
      table.userId,
      table.appRowId,
    ),
    index("user_app_access_organization_id_idx").on(table.organizationId),
    index("user_app_access_user_id_idx").on(table.userId),
    index("user_app_access_app_row_id_idx").on(table.appRowId),
  ],
);

/**
 * Machine-to-machine app tokens for gateway access.
 * Tokens are stored as irreversible hashes; plaintext is never persisted.
 *
 * Also stores organization-scoped `eak_` deploy tokens. Deploy-token rows have
 * `app_row_id` NULL and scopes `apps:register`, `apps:deploy`.
 */
export const appTokens = sqliteTable(
  "app_tokens",
  {
    id: text("id").primaryKey(),
    appRowId: text("app_row_id").references(() => apps.id, {
      onDelete: "cascade",
    }),
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
    foreignKey({
      columns: [table.appRowId, table.organizationId],
      foreignColumns: [apps.id, apps.organizationId],
      name: "app_tokens_app_row_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("app_tokens_token_hash_unique").on(table.tokenHash),
    index("app_tokens_organization_id_idx").on(table.organizationId),
    index("app_tokens_app_row_id_idx").on(table.appRowId),
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
    fields: [userAppAccess.appRowId],
    references: [apps.id],
  }),
  grantedByUser: one(users, {
    fields: [userAppAccess.grantedBy],
    references: [users.id],
  }),
}));

export const appTokensRelations = relations(appTokens, ({ one }) => ({
  app: one(apps, {
    fields: [appTokens.appRowId],
    references: [apps.id],
  }),
  createdByUser: one(users, {
    fields: [appTokens.createdBy],
    references: [users.id],
  }),
}));
