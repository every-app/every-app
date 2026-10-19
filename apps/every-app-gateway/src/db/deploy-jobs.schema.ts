import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./auth.schema";
import { apps } from "./apps.schema";

/**
 * One deploy through the hosted deploy API (server/deploy/): a third-party
 * app's bundle on its way into the dispatch namespace. `running` while the
 * deployer works (one at a time per app), then `succeeded` or `failed`
 * with `error` (JSON `{ code, message }`). A job left `running` past the
 * deployer's deadline (its isolate went away) reads as failed. `source`
 * (JSON `{ repoUrl, tag, version, gitSha }`) is the GitHub release an
 * admin installed it from (server/deploy/install.ts); null for an upload.
 */
export const deployJobs = sqliteTable(
  "deploy_jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appRowId: text("app_row_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    error: text("error"),
    source: text("source"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("deploy_jobs_organization_id_idx").on(table.organizationId),
    index("deploy_jobs_app_row_id_status_idx").on(table.appRowId, table.status),
  ],
);
