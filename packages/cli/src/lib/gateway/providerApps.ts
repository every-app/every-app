/**
 * Provider apps in the Gateway's registry (`@every-app/sdk/internal`
 * providerApps.ts): a data provider the operator turns on as an app with
 * no Worker, written the way every registry change is (ADR-0003: the CLI
 * writes the Gateway's D1 itself under the operator's Cloudflare login).
 * The rules are `@every-app/perimeter/registry`'s (providerApps.ts); this
 * reads the rows they need and writes what they return in one batch.
 *
 * A provider app is the install organization's: `on` creates the row
 * `active` at once (nothing to upload or bind) and grants it to the person
 * turning it on and the organization's owners and admins; `off` leaves a
 * tombstone like `everyapp delete`, with everyone's access, its tokens, its
 * tools snapshot and its place in AI connections gone. The Gateway reads a
 * change within 30 seconds.
 */
import {
  DELETED_APP_STATUS,
  planProviderAppOn,
  providerAppId,
  providerAppOffUpdate,
  type ProviderAppPlan,
} from "@every-app/perimeter/registry";
import {
  PROVIDER_APP_IDS,
  PROVIDER_APP_TIER,
  PROVIDER_APPS,
  providerAppKeySetting,
  type ProviderAppId,
} from "@every-app/sdk/internal";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import {
  APP_COLUMNS,
  ensureInstallOrganization,
  installOrganization,
  memberQueries,
  registryCall,
  text,
  toAppRow,
  toMembers,
  withoutAppData,
  type Deployer,
  type Organization,
  type StoredAppRow,
} from "./registry";

/** One provider app as `provider list` reports it. */
interface ProviderAppState {
  id: ProviderAppId;
  name: string;
  description: string;
  /** The Gateway setting holding its key (`DATAFORSEO_API_KEY`). */
  keySetting: string;
  /** Whether the install organization has it on. */
  on: boolean;
}

interface ProviderAppOnInput {
  id: string;
  deployer: Deployer;
  /** Names the organization created when the gateway has none yet. */
  organizationName: string;
  now?: number;
}

interface ProviderAppOn {
  plan: ProviderAppPlan;
  organization: Organization;
  /** The gateway has an owner. */
  hasOwner: boolean;
  /** The person turning it on is a member and was granted it (or had it). */
  actorGranted: boolean;
}

/** The install organization's row for a provider app id, tombstones included. */
async function providerRow(
  db: D1Database,
  organizationId: string,
  id: string,
): Promise<StoredAppRow | null> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND app_slug = ?`,
      params: [organizationId, id],
    },
  ]);
  return rows[0] ? toAppRow(rows[0]) : null;
}

/** What turning a provider app on writes, in one batch. */
function onWrites(plan: ProviderAppPlan, now: number): D1Statement[] {
  const { app } = plan;
  if (plan.kind === "existing") {
    return [
      {
        sql: "UPDATE apps SET name = ?, description = ?, manifest = ?, updated_at = ? WHERE id = ?",
        params: [app.name, app.description, app.manifest, now, app.id],
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
    ...withoutAppData(app, now),
    ...grants,
  ];
}

/**
 * Turn a provider app on in the install organization (created when the
 * gateway has none yet, as a deploy does): a new row, its own tombstone
 * revived, or one that is on already, which only gets the registry's
 * current name and description.
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
        sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND app_slug = ?`,
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
    await db.run(onWrites(plan, now));
    const actorGranted =
      actorUserId !== null &&
      (plan.grants.some((grant) => grant.userId === actorUserId) ||
        (plan.kind === "existing" && (await hasAccess(db, plan.app.id, actorUserId))));
    return { plan, organization, hasOwner, actorGranted };
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

/**
 * Turn a provider app off: a tombstone, as `everyapp delete` leaves (its
 * access, tokens, tools snapshot and AI connections gone). An app that is
 * off writes nothing, so this can run again. Whether it was on.
 */
export function turnProviderAppOff(
  db: D1Database,
  id: string,
  now = Date.now(),
): Promise<{ id: ProviderAppId; wasOn: boolean; organization: Organization | null }> {
  return registryCall(async () => {
    const providerId = providerAppId(id);
    const found = await installOrganization(db);
    if (!found) return { id: providerId, wasOn: false, organization: null };
    const app = await providerRow(db, found.organization.id, providerId);
    const update = providerAppOffUpdate(providerId, app);
    if (app && update) {
      await db.run([
        {
          sql: "UPDATE apps SET status = ?, is_default = ?, updated_at = ? WHERE id = ?",
          params: [update.status, update.isDefault ? 1 : 0, now, app.id],
        },
        ...withoutAppData(app, now),
      ]);
    }
    return { id: providerId, wasOn: update !== null, organization: found.organization };
  });
}

/**
 * Every provider app the Gateway offers, with whether the install
 * organization has it on. Reads only.
 */
export async function listProviderApps(db: D1Database): Promise<ProviderAppState[]> {
  const found = await installOrganization(db);
  const on = new Set<string>();
  if (found) {
    const [rows = []] = await db.run([
      {
        sql: `SELECT app_slug FROM apps WHERE organization_id = ? AND tier = ? AND status != '${DELETED_APP_STATUS}'`,
        params: [found.organization.id, PROVIDER_APP_TIER],
      },
    ]);
    for (const row of rows) on.add(String(row["app_slug"]));
  }
  return PROVIDER_APP_IDS.map((id) => ({
    id,
    name: PROVIDER_APPS[id].name,
    description: PROVIDER_APPS[id].description,
    keySetting: providerAppKeySetting(id),
    on: on.has(id),
  }));
}
