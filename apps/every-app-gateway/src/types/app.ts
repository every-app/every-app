import type { InferSelectModel } from "drizzle-orm";
import type { AppSetup } from "@every-app/sdk/internal";
import type { ConnectionNeed } from "@/schemas/app-access";
import { apps } from "@/db/schema";

/**
 * Base app type inferred from the Drizzle schema: catalog metadata plus the
 * perimeter routing/policy registry columns (hostname, workerName, tier, manifest,
 * status), and who deployed it. Apps are registered by `everyapp deploy`,
 * never created by hand.
 */
type AppRow = InferSelectModel<typeof apps>;
// Deploy bookkeeping (uploaded version and time) and the readiness the
// event bus last recorded (`setup_state`) stay server-side; the lists carry
// `setup` (the evaluated report) instead.
type App = Omit<
  AppRow,
  "appSlug" | "versionId" | "deployedAt" | "setupState"
> & {
  appId: AppRow["appSlug"];
};

/**
 * One capability the app's manifest lists, read against the registry for
 * Admin → Apps. An OAuth provider's entry is its `scopes` (the provider's
 * own scope strings, possibly none); every other capability's is its
 * `access`.
 */
export type AppCapabilitySummary = {
  id: string;
  label: string;
  /** An API key's or service's access; absent for an OAuth provider. */
  access?: "read" | "write";
  why?: string;
  /** For an OAuth provider: the scopes the app lists, as it wrote them. */
  scopes?: string[];
};

/**
 * What the app still needs set before it opens (server/app-setup.ts): its
 * manifest's providers, capabilities and secrets against the Gateway's
 * settings and the app Worker's recorded secret names, and the one
 * command that sets the rest. Null when the manifest declares nothing to
 * set, or the platform's settings don't gate the app (the dispatch tier).
 */
type ListedAppSetup = AppSetup | null;

/**
 * App with access count for admin views. `readOnly`: a shared app another
 * organization (the platform's) owns, listed for what it is. `capabilities`
 * is computed from the stored manifest on the server, where the registry is.
 */
export type AppWithAccessCount = App & {
  accessCount: number;
  readOnly: boolean;
  capabilities: AppCapabilitySummary[];
  setup: ListedAppSetup;
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
  | "tier"
  | "status"
  | "everyone"
  | "createdAt"
  | "updatedAt"
> & {
  grantedAt: Date | number;
  /** The group when a group is the viewer's only way in; null otherwise (and for a shared app). */
  via: { groupId: string; name: string } | null;
  /** The path of the launcher icon the app's manifest names (`icon`), or null. */
  icon: string | null;
  setup: ListedAppSetup;
  /**
   * The OAuth providers the app requires that the viewer hasn't connected
   * or allowed it yet (server/oauth/connection-needs.ts): it doesn't open
   * for them until each is done, and the setup dialog shows the buttons.
   */
  connections: ConnectionNeed[];
  /**
   * The app has reached the viewer organization's monthly cap on its
   * provider calls this UTC month: it opens, but the Gateway refuses its
   * AI and provider calls until the month ends or an owner or admin raises
   * the cap under Manage workspace → Usage.
   */
  paused: boolean;
};

/**
 * User with access status for managing app access: `hasAccess` is a
 * person's grant, the one the modal edits; `admin` says their role opens
 * the app (owners and admins open every app); `viaGroups` names the groups
 * that grant the app too (empty for none).
 */
export type UserAccessState = {
  id: string;
  name: string;
  email: string;
  role: string | null;
  status: string | null;
  hasAccess: boolean;
  admin: boolean;
  viaGroups: string[];
};
