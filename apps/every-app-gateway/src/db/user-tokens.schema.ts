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
import { apps } from "./apps.schema";

export const userAccessTokens = sqliteTable(
  "user_access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appRowId: text("app_row_id").references(() => apps.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    foreignKey({
      columns: [table.appRowId, table.organizationId],
      foreignColumns: [apps.id, apps.organizationId],
      name: "user_access_tokens_app_row_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("user_access_tokens_token_hash_unique").on(table.tokenHash),
    index("user_access_tokens_user_id_idx").on(table.userId),
    index("user_access_tokens_organization_id_idx").on(table.organizationId),
    index("user_access_tokens_app_row_id_idx").on(table.appRowId),
    index("user_access_tokens_token_prefix_idx").on(table.tokenPrefix),
    index("user_access_tokens_revoked_at_idx").on(table.revokedAt),
  ],
);

export const userAccessTokensRelations = relations(
  userAccessTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [userAccessTokens.userId],
      references: [users.id],
    }),
    organization: one(organizations, {
      fields: [userAccessTokens.organizationId],
      references: [organizations.id],
    }),
    app: one(apps, {
      fields: [userAccessTokens.appRowId],
      references: [apps.id],
    }),
  }),
);
