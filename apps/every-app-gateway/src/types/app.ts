import type { InferSelectModel } from "drizzle-orm";
import { apps } from "@/db/schema";

/**
 * Base app type inferred from the Drizzle schema: catalog metadata plus the
 * perimeter routing/policy registry columns (hostname, workerName, tier, manifest,
 * status). Apps are registered by `everyapp deploy`, never created by hand.
 */
type AppRow = InferSelectModel<typeof apps>;
type App = Omit<AppRow, "appSlug"> & { appId: AppRow["appSlug"] };

/**
 * App with access count for admin views.
 */
export type AppWithAccessCount = App & {
  accessCount: number;
};

/**
 * App as seen by the launcher: catalog metadata plus the routing hostname and
 * status (the worker/manifest internals stay server-side), with the granted
 * timestamp from the access record.
 */
export type UserAccessApp = Pick<
  App,
  | "id"
  | "organizationId"
  | "appId"
  | "name"
  | "description"
  | "hostname"
  | "status"
  | "isDefault"
  | "createdAt"
  | "updatedAt"
> & {
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
