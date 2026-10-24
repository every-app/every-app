import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  // The Gateway's user id (`user.id`); every query filters by it.
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});
