/**
 * Built-in provider apps in the Gateway's registry (`@every-app/sdk/internal`
 * providerApps.ts): a data provider the Gateway serves as an MCP app of its
 * own (DataForSEO), turned on the way every registry change is written
 * (ADR-0003: the CLI writes the Gateway's D1 itself under the operator's
 * Cloudflare login). The rules are `@every-app/perimeter/registry`'s
 * (providerApps.ts); this reads the rows they need and writes what they
 * return in one batch.
 *
 * A provider app is the install organization's: its first `on` creates the
 * row `active` at once (nothing to upload or bind) and grants it to the
 * person turning it on and the organization's owners and admins; `on`
 * after `mcp off` (status `disabled`) serves it again with everything kept;
 * `on` after `mcp remove` (a tombstone) brings it back as new. Off and
 * remove are lib/gateway/remoteMcpApps.ts's, the same for both kinds of MCP
 * app. The Gateway reads a change within 30 seconds.
 */
import {
  DELETED_APP_STATUS,
  planProviderAppOn,
  providerAppId,
  type ProviderAppPlan,
} from "@every-app/perimeter/registry";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import {
  appColumns,
  hasSecretNamesColumn,
  ensureInstallOrganization,
  memberQueries,
  registryCall,
  text,
  toAppRow,
  toMembers,
  withoutAppData,
  type Deployer,
  type Organization,
} from "./registry";

interface ProviderAppOnInput {
  id: string;
  deployer: Deployer;
  /** Names the organization created when the gateway has none yet. */
  organizationName: string;
  now?: number;
}

interface ProviderAppOn {
  plan: ProviderAppPlan;
  /**
   * What it was before: `new` (no row), `revived` (removed), `off`
   * (`mcp off`, now served again) or `existing` (on already).
   */
  was: "new" | "revived" | "off" | "existing";
  organization: Organization;
  /** The gateway has an owner. */
  hasOwner: boolean;
  /** The person turning it on is a member and was granted it (or had it). */
  actorGranted: boolean;
}

/** What turning a provider app on writes, in one batch. */
function onWrites(
  plan: ProviderAppPlan,
  now: number,
  columns: { secretNames: boolean },
): D1Statement[] {
  const { app } = plan;
  if (plan.kind === "existing") {
    // On already, or off: served again, with the registry's name and description.
    return [
      {
        sql: "UPDATE apps SET name = ?, description = ?, manifest = ?, status = ?, updated_at = ? WHERE id = ?",
        params: [app.name, app.description, app.manifest, app.status, now, app.id],
      },
    ];
  }
  const grants = plan.grants.map((grant) => ({
    sql: `INSERT INTO user_app_access (id, user_id, app_row_id, organization_id, granted_by)
VALUES (?, ?, ?, ?, NULL) ON CONFLICT DO NOTHING`,
    params: [grant.id, grant.userId, grant.appRowId, grant.organizationId],
  }));
  if (plan.kind === "new") {
    return [
      {
        sql: `INSERT INTO apps (id, organization_id, app_slug, name, description, hostname,
  worker_name, tier, manifest, status, version_id, deployed_at, deployed_by_actor,
  is_default, created_at, updated_at, scope)
VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?8, NULL, ?9, ?10, 0, ?11, ?11, ?12)`,
        params: [
          app.id,
          app.organizationId,
          app.appSlug,
          app.name,
          app.description,
          app.tier,
          app.manifest,
          app.status,
          app.deployedAt,
          app.deployedByActor,
          now,
          app.scope,
        ],
      },
      ...grants,
    ];
  }
  // Its own tombstone comes back: as new, with nothing of the old access.
  return [
    {
      sql: `UPDATE apps SET name = ?, description = ?, manifest = ?, status = ?, is_default = 0,
  deployed_at = ?, deployed_by_actor = ?, updated_at = ?
WHERE id = ? AND status = '${DELETED_APP_STATUS}'`,
      params: [
        app.name,
        app.description,
        app.manifest,
        app.status,
        app.deployedAt,
        app.deployedByActor,
        now,
        app.id,
      ],
    },
    ...withoutAppData(app, now, columns),
    ...grants,
  ];
}

/**
 * Turn a provider app on in the install organization (created when the
 * gateway has none yet, as a deploy does): a new row, its own tombstone
 * revived, one that was off served again, or one that is on already,
 * which only gets the registry's current name and description.
 */
export function turnProviderAppOn(
  db: D1Database,
  input: ProviderAppOnInput,
): Promise<ProviderAppOn> {
  return registryCall(async () => {
    const now = input.now ?? Date.now();
    const id = providerAppId(input.id);
    const { organization, hasOwner } = await ensureInstallOrganization(
      db,
      input.organizationName,
      now,
    );
    const [existing = [], members = [], actors = []] = await db.run([
      {
        sql: `SELECT ${await appColumns(db)} FROM apps WHERE organization_id = ? AND app_slug = ?`,
        params: [organization.id, id],
      },
      ...memberQueries(organization.id, input.deployer.email),
    ]);
    const existingApp = existing[0] ? toAppRow(existing[0]) : null;
    const actorUserId = text(actors[0]?.["id"]);
    const plan = planProviderAppOn({
      organizationId: organization.id,
      id,
      existingApp,
      members: toMembers(members),
      actorUserId,
      actor: input.deployer.actor,
      now,
    });
    const was =
      plan.kind === "existing" ? (existingApp?.status === "active" ? "existing" : "off") : plan.kind;
    // events: mcp_app.added (kind "builtin", when was is new or revived)
    // events: mcp_app.enabled (kind "builtin", when was is off)
    await db.run(onWrites(plan, now, { secretNames: await hasSecretNamesColumn(db) }));
    const actorGranted =
      actorUserId !== null &&
      (plan.grants.some((grant) => grant.userId === actorUserId) ||
        (plan.kind === "existing" && (await hasAccess(db, plan.app.id, actorUserId))));
    return { plan, was, organization, hasOwner, actorGranted };
  });
}

async function hasAccess(db: D1Database, appRowId: string, userId: string): Promise<boolean> {
  const [rows = []] = await db.run([
    {
      sql: "SELECT 1 AS granted FROM user_app_access WHERE app_row_id = ? AND user_id = ? LIMIT 1",
      params: [appRowId, userId],
    },
  ]);
  return rows.length > 0;
}
