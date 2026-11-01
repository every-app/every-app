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
 * Organization app catalog - managed per organization. The CLI writes the
 * registry columns straight into D1 in self-host (ADR-0003), with the
 * rules in `@every-app/perimeter/registry`.
 */
export const apps = sqliteTable(
  "apps",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appSlug: text("app_slug").notNull(), // e.g., "crm"
    name: text("name").notNull(),
    description: text("description").notNull(),
    // --- perimeter routing + policy registry columns ---
    // Full routing hostname, e.g. "todo-acme.example.com" (unique per gateway).
    hostname: text("hostname").unique(),
    // Service-binding / script name assigned at registration,
    // "every-<orgKey>-<appId>". Unique per gateway: worker names share one
    // Cloudflare-account namespace, and D1/KV resource names derive from
    // them.
    workerName: text("worker_name").unique(),
    // 'service_binding' now; 'dispatch' reserved for third-party apps on
    // the hosted gateway. Any other value is unroutable (a 503), never
    // coerced (packages/perimeter/src/registry/apps.ts).
    tier: text("tier").notNull().default("service_binding"),
    // 'org': the organization's own app. 'shared': a first-party app the
    // platform organization owns, for members of every organization (the
    // hosted gateway). Parsed like `tier`.
    scope: text("scope").notNull().default("org"),
    // JSON snapshot of everyapp.config.ts, taken when a deploy uploads the
    // app's Worker, so a new route policy goes live with the new code.
    manifest: text("manifest"),
    // The installation's email configuration (`everyapp email set`), never
    // the manifest's: a release bakes the manifest in, and whoever installs
    // it must not inherit the first deployer's domain. JSON string[] of the
    // `from` patterns the gateway lets the app send as, and of the addresses
    // the CLI routes to its Worker with Email Routing. Null: none set.
    emailSenders: text("email_senders"),
    emailInbound: text("email_inbound"),
    // JSON string[] of the secrets on the app's own Worker, as the CLI
    // last recorded them (deploy, register, secret set|unset, status),
    // everyapp's own left out. The settings model reads it to say whether
    // a required secret of the app's own is set; null (never recorded)
    // counts as unknown and never blocks.
    secretNames: text("secret_names"),
    // Whether the app had every required setting the last time its
    // readiness was evaluated (server/app-setup.ts; the CLI after
    // configure, secret set|unset and deploy): "ready" | "needs_setup",
    // or null when never evaluated. The event bus emits app.ready and
    // app.needs_setup on a transition (docs/design/2026-10-events-out.md).
    setupState: text("setup_state"),
    // The app's deploy state:
    //  - 'pending': registered, its Worker not uploaded yet (not bound);
    //  - 'binding': uploaded; the first request that reaches it over the
    //    gateway's service binding makes it 'active';
    //  - 'active' | 'disabled' (bound, 503 while disabled);
    //  - 'deleted': a tombstone, unrouted and hidden, but its slug, hostname
    //    and worker name stay reserved to its organization.
    status: text("status").notNull().default("active"),
    // The Worker version and time of the last upload, and who uploaded it:
    // the Cloudflare login's email, or `api-token:<account id>` in CI.
    versionId: text("version_id"),
    deployedAt: integer("deployed_at", { mode: "timestamp_ms" }),
    deployedByActor: text("deployed_by_actor"),
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

// Relations
export const appsRelations = relations(apps, ({ many }) => ({
  userAccess: many(userAppAccess),
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
