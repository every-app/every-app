import type { InferSelectModel } from "drizzle-orm";
import { users } from "@/db/schema";

export type AdminUser = Pick<
  InferSelectModel<typeof users>,
  "id" | "name" | "email" | "role" | "status" | "createdAt" | "banned"
>;
