import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";
export * from "./auth.schema";
export * from "./onboarding.schema";

export const userApps = sqliteTable(
  "user_apps",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    appId: text("app_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    appUrl: text("app_url").notNull(),
    devUrl: text("dev_url"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_apps_user_id_app_id_unique").on(
      table.userId,
      table.appId,
    ),
  ],
);
