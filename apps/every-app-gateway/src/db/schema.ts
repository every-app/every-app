import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";
export * from "./auth.schema";

export const userApps = sqliteTable("user_apps", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  appUrl: text("app_url").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});
