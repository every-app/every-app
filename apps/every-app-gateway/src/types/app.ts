import type { InferSelectModel } from "drizzle-orm";
import { apps } from "@/db/schema";

/**
 * Base app type inferred from the Drizzle schema.
 * This represents an app in the catalog.
 */
type App = InferSelectModel<typeof apps>;

/**
 * App with access count for admin views.
 */
export type AppWithAccessCount = App & {
  accessCount: number;
};

/**
 * App with granted timestamp for user views.
 */
export type UserAccessApp = App & {
  grantedAt: Date | number;
};

/**
 * User with access status for managing app access.
 */
export type UserAccessState = {
  id: string;
  name: string;
  email: string;
  role: string | null;
  status: string | null;
  hasAccess: boolean;
};
