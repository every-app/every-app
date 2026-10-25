import type { InferSelectModel } from "drizzle-orm";
import type { AppSetup } from "@every-app/sdk/internal";
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
 * Admin → Apps. `scopeSets` are the sets a scoped OAuth client's entry
 * names, labelled; `scopesStatus` says whether that grant holds: `ok`,
 * `undeclared` (a scoped client listed without usable sets, so the gateway
 * refuses its tokens), `unknown` (a set this gateway doesn't offer) or
 * `none` (a capability that takes no sets).
 */
export type AppCapabilitySummary = {
  id: string;
  label: string;
  access: "read" | "write";
  why?: string;
  /** `access` is absent on a set this gateway doesn't offer. */
  scopeSets: { name: string; label: string; access?: "read" | "write" }[];
  scopesStatus: "ok" | "undeclared" | "unknown" | "none";
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
  | "isDefault"
  | "createdAt"
  | "updatedAt"
> & {
  grantedAt: Date | number;
  /** The group the grant comes through, or null for a direct grant (and a shared app). */
  via: { groupId: string; name: string } | null;
  /** The path of the launcher icon the app's manifest names (`icon`), or null. */
  icon: string | null;
  setup: ListedAppSetup;
  /**
   * The app has reached the viewer organization's monthly cap on its
   * provider calls this UTC month: it opens, but the Gateway refuses its
   * AI and provider calls until the month ends or an owner or admin raises
   * the cap under Manage workspace → Usage.
   */
  paused: boolean;
};

/**
 * User with access status for managing app access: `hasAccess` is a direct
 * grant, the one the modal edits; `viaGroups` names the groups that grant
 * the app too (empty for none).
 */
export type UserAccessState = {
  id: string;
  name: string;
  email: string;
  role: string | null;
  status: string | null;
  hasAccess: boolean;
  viaGroups: string[];
};
