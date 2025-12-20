import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

export const userOnboarding = sqliteTable(
  "user_onboarding",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pwaInstallCompleted: integer("pwa_install_completed", { mode: "boolean" })
      .default(false)
      .notNull(),
    pwaInstallSkipCount: integer("pwa_install_skip_count").default(0).notNull(),
    pwaInstallSkippedAt: integer("pwa_install_skipped_at", {
      mode: "timestamp",
    }),
    pwaInstallSkippedPermanently: integer("pwa_install_skipped_permanently", {
      mode: "boolean",
    })
      .default(false)
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("user_onboarding_user_id_unique").on(table.userId)],
);
