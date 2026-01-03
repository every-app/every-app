import type { InferSelectModel } from "drizzle-orm";
import { userApps } from "@/db/schema";

/**
 * UserApp type inferred from the Drizzle schema.
 * This ensures the type stays in sync with the database schema automatically.
 */
export type UserApp = InferSelectModel<typeof userApps>;
