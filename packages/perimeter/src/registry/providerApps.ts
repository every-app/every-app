/**
 * The registry rules for provider apps (`@every-app/sdk/internal`
 * providerApps.ts): a data provider the operator turns on as an app of the
 * Gateway's own, with no Worker. Pure functions over rows the caller read,
 * like ./registration.ts: the CLI runs them against the Gateway's D1
 * (`everyapp mcp on|off`), a hosted control plane later.
 *
 * A provider app's row has the provider's id as its slug, tier "provider",
 * no hostname and no Worker name, the generated manifest, and is `active`
 * from the start (there is nothing to upload or bind). Turning it on is
 * idempotent: a row that is on keeps its access and gets the registry's
 * current name and description; a tombstone of its own comes back as new,
 * with nothing of the old access. The same id taken by a deployed app of
 * the organization's is refused (APP_TIER_MISMATCH), tombstones included:
 * the deployed app keeps its names.
 *
 * Who gets a provider app when it is turned on follows a deployed app's
 * rule: the person turning it on and the organization's owners and admins,
 * nobody else until an admin grants them (Manage access). It is never an
 * organization's default.
 */
import {
  isProviderAppId,
  PROVIDER_APP_IDS,
  PROVIDER_APP_TIER,
  PROVIDER_APPS,
  providerAppManifest,
  type ProviderAppId,
} from "@every-app/sdk/internal";
import {
  DELETED_APP_STATUS,
  deleteUpdate,
  RegistrationError,
  type AccessGrant,
  type AppRow,
  type OrganizationMember,
} from "./registration";

export interface ProviderAppInput {
  organizationId: string;
  /** The provider app's id (`dataforseo`). */
  id: string;
  /** The organization's row for this id, tombstones included. */
  existingApp: AppRow | null;
  /** The organization's members, for the app's initial access. */
  members: readonly OrganizationMember[];
  /** The member turning it on, when the operator is one. */
  actorUserId: string | null;
  /** Who turned it on, as the row records it (`deployed_by_actor`). */
  actor: string | null;
  now: number;
}

export interface ProviderAppPlan {
  /**
   * `new`: insert `app` and `grants`. `revived`: a tombstone of this
   * organization's comes back as `app` with `grants`, nothing of the old
   * access kept. `existing`: the app has a live row (on, or off with
   * `mcp off`); update its name, description and status (`active`) and
   * nothing else.
   */
  kind: "new" | "revived" | "existing";
  app: AppRow;
  grants: AccessGrant[];
}

function isOwnerOrAdmin(role: string | null): boolean {
  return (role ?? "")
    .split(",")
    .some((item) => ["owner", "admin"].includes(item.trim()));
}

/** The id as an MCP app's, or the refusal naming the ones there are. */
export function providerAppId(id: string): ProviderAppId {
  if (isProviderAppId(id)) return id;
  throw new RegistrationError({
    status: 400,
    code: "PROVIDER_APP_UNKNOWN",
    message: `"${id}" is not an MCP app. The Gateway offers: ${PROVIDER_APP_IDS.join(", ")}.`,
  });
}

/** A row that is a deployed app's, not an MCP app's. */
function assertProviderRow(id: string, existingApp: AppRow): void {
  if (existingApp.tier === PROVIDER_APP_TIER) return;
  throw new RegistrationError({
    status: 409,
    code: "APP_TIER_MISMATCH",
    message: `"${id}" is an app deployed to this Gateway${existingApp.status === DELETED_APP_STATUS ? " (deleted, its names still its organization's)" : ""}, not the MCP app; the MCP app can't take its id.`,
  });
}

/**
 * Turn a provider app on: what to write, from the organization's row for
 * the id (if any) and its members.
 */
export function planProviderAppOn(input: ProviderAppInput): ProviderAppPlan {
  const id = providerAppId(input.id);
  const { existingApp } = input;
  if (
    existingApp &&
    (existingApp.organizationId !== input.organizationId ||
      existingApp.appSlug !== id)
  ) {
    throw new Error("existingApp is another organization's or app's row.");
  }
  const definition = PROVIDER_APPS[id];
  if (existingApp) assertProviderRow(id, existingApp);
  if (existingApp && existingApp.status !== DELETED_APP_STATUS) {
    // On already, or off (`mcp off`: status "disabled", everything kept):
    // `on` serves it again with the registry's current name and description.
    return {
      kind: "existing",
      app: {
        ...existingApp,
        name: definition.name,
        description: definition.description,
        manifest: JSON.stringify(providerAppManifest(id)),
        status: "active",
      },
      grants: [],
    };
  }
  const rowId = existingApp?.id ?? crypto.randomUUID();
  const app: AppRow = {
    id: rowId,
    organizationId: input.organizationId,
    appSlug: id,
    name: definition.name,
    description: definition.description,
    hostname: null,
    workerName: null,
    tier: PROVIDER_APP_TIER,
    scope: "org",
    manifest: JSON.stringify(providerAppManifest(id)),
    status: "active",
    versionId: null,
    deployedAt: input.now,
    deployedByActor: input.actor,
    isDefault: false,
  };
  const grants: AccessGrant[] = input.members
    .filter(
      (member) =>
        member.id === input.actorUserId || isOwnerOrAdmin(member.role),
    )
    .map((member) => ({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      userId: member.id,
      appRowId: rowId,
      grantedBy: null,
    }));
  return { kind: existingApp ? "revived" : "new", app, grants };
}

/**
 * Turn a provider app off: the tombstone update to write (a deleted app's,
 * {@link deleteUpdate}; the caller drops everyone's access, its tokens, its
 * tools snapshot and its place in AI connections with it), or null when
 * there is nothing on: no row, a tombstone already, or a deployed app's
 * row, which this never touches.
 */
export function providerAppOffUpdate(
  id: string,
  existingApp: AppRow | null,
): ReturnType<typeof deleteUpdate> {
  providerAppId(id);
  if (!existingApp || existingApp.tier !== PROVIDER_APP_TIER) return null;
  return deleteUpdate(existingApp);
}
