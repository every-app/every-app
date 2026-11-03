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
 * row `active` at once (nothing to upload or bind), open to the
 * organization's owners and admins (an admin grants others); `on`
 * after `mcp off` (status `disabled`) serves it again with everything kept;
 * `on` after `mcp remove` (a tombstone) brings it back as new. Off and
 * remove are lib/gateway/remoteMcpApps.ts's, the same for both kinds of MCP
 * app. The Gateway reads a change within 30 seconds. `on` queues its event
 * in the same batch (the outbox, ./events.ts), kind `builtin`:
 * `mcp_app.added` for a row that is new or revived, `mcp_app.enabled` for
 * one that was off, nothing for one on already.
 */
import {
  DELETED_APP_STATUS,
  planProviderAppOn,
  providerAppId,
  type ProviderAppPlan,
} from "@every-app/perimeter/registry";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { operatorActor, queueEventFromCli } from "./events";
import {
  appColumns,
  hasSecretNamesColumn,
  ensureInstallOrganization,
  registryCall,
  toAppRow,
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
  if (plan.kind === "new") {
    return [
      {
        sql: `INSERT INTO apps (id, organization_id, app_slug, name, description, hostname,
  worker_name, tier, manifest, status, version_id, deployed_at, deployed_by_actor,
  everyone, created_at, updated_at, scope)
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
    ];
  }
  // Its own tombstone comes back: as new, with nothing of the old access.
  return [
    {
      sql: `UPDATE apps SET name = ?, description = ?, manifest = ?, status = ?, everyone = 0,
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
    const [existing = []] = await db.run([
      {
        sql: `SELECT ${await appColumns(db)} FROM apps WHERE organization_id = ? AND app_slug = ?`,
        params: [organization.id, id],
      },
    ]);
    const existingApp = existing[0] ? toAppRow(existing[0]) : null;
    const plan = planProviderAppOn({
      organizationId: organization.id,
      id,
      existingApp,
      actor: input.deployer.actor,
      now,
    });
    const was =
      plan.kind === "existing" ? (existingApp?.status === "active" ? "existing" : "off") : plan.kind;
    // A new or revived row is an MCP app added, one that was off enabled; one on already, nothing.
    const event =
      was === "existing"
        ? []
        : await queueEventFromCli(db, {
            organizationId: organization.id,
            type: was === "off" ? "mcp_app.enabled" : "mcp_app.added",
            actor: operatorActor(input.deployer),
            data: { app: { id: plan.app.appSlug, rowId: plan.app.id, name: plan.app.name }, kind: "builtin" },
            appRowId: plan.app.id,
            // The revival is conditional on the tombstone: only if the row was written now, and serves.
            onlyIf: {
              sql: "EXISTS (SELECT 1 FROM apps WHERE id = ? AND status = ? AND updated_at = ?)",
              params: [plan.app.id, plan.app.status, now],
            },
            now,
          });
    await db.run([...onWrites(plan, now, { secretNames: await hasSecretNamesColumn(db) }), ...event]);
    return { plan, was, organization, hasOwner };
  });
}
