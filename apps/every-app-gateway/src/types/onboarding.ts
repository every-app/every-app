import type { InferSelectModel } from "drizzle-orm";
import { userOnboarding } from "@/db/schema";

/**
 * UserOnboarding type inferred from the Drizzle schema.
 * This ensures the type stays in sync with the database schema automatically.
 */
export type UserOnboarding = InferSelectModel<typeof userOnboarding>;
