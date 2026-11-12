/**
 * Renaming an app (docs/design/2026-11-app-rename.md): `everyapp deploy` of
 * a manifest whose `id` isn't registered while one of its `previousIds` is.
 * The rules are the perimeter's (`planRename`, `previousIdChanges`); this
 * module reads the rows they need, writes what they decide, and says what a
 * rename keeps and changes, for the confirmation.
 *
 *   plan ─▶ confirm ─▶ write (id, hostname; old ones a previous id, served
 *   in full) ─▶ the usual deploy ─▶ new hostname answers ─▶ moved (page
 *   loads on the old host redirect)
 *
 * The app's row keeps its primary key and Worker name, so everything the
 * Gateway holds for it and every resource it binds stay with it.
 */
import {
  DELETED_APP_STATUS,
  planRename,
  previousIdChanges,
  type AppResources,
  type PreviousIdChanges,
  type PreviousIdRow,
  type RenamePlan,
} from "@every-app/perimeter/registry";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { probeHttps } from "@/lib/domains/https";
import { EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { elapsed } from "@/lib/output/time";
import { APP_COLUMNS, installOrganization, registryCall, text, toAppRow, type Organization } from "./registry";

type D1Row = Record<string, unknown>;

const PREVIOUS_ID_COLUMNS = "organization_id, app_slug, app_row_id, hostname, renamed_at, moved_at, retired_at";

const at = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function toPreviousIdRow(row: D1Row): PreviousIdRow {
  return {
    organizationId: String(row["organization_id"]),
    appSlug: String(row["app_slug"]),
    appRowId: String(row["app_row_id"]),
    hostname: String(row["hostname"]),
    renamedAt: Number(row["renamed_at"]),
    movedAt: at(row["moved_at"]),
    retiredAt: at(row["retired_at"]),
  };
}

/** An app's previous ids, retired ones included, oldest first. */
async function readPreviousIds(db: D1Database, appRowId: string): Promise<PreviousIdRow[]> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${PREVIOUS_ID_COLUMNS} FROM app_previous_ids WHERE app_row_id = ? ORDER BY renamed_at, app_slug`,
      params: [appRowId],
    },
  ]);
  return rows.map(toPreviousIdRow);
}

/** The manifest fields a rename reads. */
interface RenameManifest {
  id: string;
  previousIds?: readonly string[];
}

interface PlannedRename {
  plan: RenamePlan;
  organization: Organization;
}

const listed = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(", ");

/**
 * What a deploy of `manifest` does about its `previousIds`, decided before
 * anything is registered:
 *
 * - `id` is registered (a tombstone too): a deploy as usual; each listed id
 *   must be one of that app's previous ids. One that is another app is
 *   RENAME_TARGET_EXISTS (two apps don't merge); one that is nothing is
 *   PREVIOUS_ID_UNKNOWN.
 * - `id` isn't, and one app answers to the listed ids (as its id or a
 *   previous one): the rename of that app, planned (null when nothing is listed).
 * - None does: PREVIOUS_ID_UNKNOWN, never a new app. More than one:
 *   RENAME_AMBIGUOUS.
 */
export function planRenameFor(
  db: D1Database,
  input: {
    manifest: RenameManifest;
    appBaseDomain: string;
    gatewayName: string | null;
    now?: number;
  },
): Promise<PlannedRename | null> {
  return registryCall(() => planRenameIn(db, input));
}

async function planRenameIn(
  db: D1Database,
  {
    manifest,
    appBaseDomain,
    gatewayName,
    now,
  }: { manifest: RenameManifest; appBaseDomain: string; gatewayName: string | null; now?: number },
): Promise<PlannedRename | null> {
  const previous = [...(manifest.previousIds ?? [])];
  if (previous.length === 0) return null;
  const found = await installOrganization(db);
  if (!found) throw unknownPreviousIds(manifest.id, previous);
  const { organization } = found;
  const slugs = [manifest.id, ...previous];
  const marks = slugs.map(() => "?").join(", ");
  const [appRows = [], previousRows = [], keys = []] = await db.run([
    {
      sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND app_slug IN (${marks})`,
      params: [organization.id, ...slugs],
    },
    {
      sql: `SELECT ${PREVIOUS_ID_COLUMNS} FROM app_previous_ids WHERE organization_id = ? AND app_slug IN (${marks})`,
      params: [organization.id, ...slugs],
    },
    { sql: "SELECT org_key FROM organization_keys WHERE organization_id = ?", params: [organization.id] },
  ]);
  const apps = appRows.map(toAppRow);
  const previousIds = previousRows.map(toPreviousIdRow);
  const target = apps.find((app) => app.appSlug === manifest.id) ?? null;
  const live = apps.filter((app) => app.appSlug !== manifest.id && app.status !== DELETED_APP_STATUS);

  if (target) {
    const others = live.filter((app) => app.id !== target.id);
    if (others.length > 0) throw targetExists(manifest.id, others.map((app) => app.appSlug));
    const own = new Set(previousIds.filter((row) => row.appRowId === target.id).map((row) => row.appSlug));
    const unknown = previous.filter((id) => !own.has(id));
    if (unknown.length > 0) throw unknownPreviousIds(manifest.id, unknown, true);
    return null;
  }

  // The app each listed id names: as its id now, or as one it had.
  const owners = new Map<string, string>();
  for (const id of previous) {
    const app = live.find((candidate) => candidate.appSlug === id);
    const row = previousIds.find((candidate) => candidate.appSlug === id);
    const owner = app?.id ?? row?.appRowId;
    if (owner) owners.set(id, owner);
  }
  const rowIds = new Set(owners.values());
  if (rowIds.size === 0) throw unknownPreviousIds(manifest.id, previous);
  if (rowIds.size > 1) {
    throw new EveryAppError(
      "RENAME_AMBIGUOUS",
      `previousIds names more than one app on this Gateway: ${listed([...owners.keys()])}\nA rename moves one app to "${manifest.id}"; two apps can't be merged. Nothing was deployed.`,
      { fix: "list only the ids of the one app being renamed under previousIds in everyapp.config.ts" },
    );
  }
  const unknown = previous.filter((id) => !owners.has(id));
  if (unknown.length > 0) throw unknownPreviousIds(manifest.id, unknown);
  const [rowId] = rowIds;
  const [fromRows = [], ownPrevious = []] = await db.run([
    { sql: `SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`, params: [rowId!] },
    {
      sql: `SELECT ${PREVIOUS_ID_COLUMNS} FROM app_previous_ids WHERE app_row_id = ? ORDER BY renamed_at, app_slug`,
      params: [rowId!],
    },
  ]);
  if (!fromRows[0]) throw unknownPreviousIds(manifest.id, previous);
  const from = toAppRow(fromRows[0]);
  if (from.status === DELETED_APP_STATUS) {
    throw new EveryAppError(
      "PREVIOUS_ID_UNKNOWN",
      `${listed(previous)} was deleted from this Gateway, so there is no app to rename to "${manifest.id}". Nothing was deployed.`,
      { fix: `remove previousIds from everyapp.config.ts to deploy "${manifest.id}" as a new app` },
    );
  }
  const orgKey = text(keys[0]?.["org_key"]);
  if (!orgKey) throw new Error(`Organization ${organization.slug} has no key, yet it has apps.`);
  // Who holds the hostname the new id gets: read once the rules name it.
  const hostname = `${manifest.id}.${appBaseDomain.trim().toLowerCase().replace(/\.$/, "")}`;
  const [hostApps = [], hostPrevious = []] = await db.run([
    { sql: "SELECT organization_id, app_slug, hostname, worker_name FROM apps WHERE hostname = ?", params: [hostname] },
    { sql: `SELECT ${PREVIOUS_ID_COLUMNS} FROM app_previous_ids WHERE hostname = ?`, params: [hostname] },
  ]);
  const plan = planRename({
    app: from,
    toSlug: manifest.id,
    manifest,
    isInstallOrganization: true,
    appBaseDomain,
    orgKey,
    gatewayName,
    previousIds: ownPrevious.map(toPreviousIdRow),
    toSlugApp: null,
    toSlugPreviousId: previousIds.find((row) => row.appSlug === manifest.id) ?? null,
    hostnameOwner: hostApps[0]
      ? {
          organizationId: String(hostApps[0]["organization_id"]),
          appSlug: String(hostApps[0]["app_slug"]),
          hostname: text(hostApps[0]["hostname"]),
          workerName: text(hostApps[0]["worker_name"]),
        }
      : null,
    hostnamePreviousOwner: hostPrevious[0] ? toPreviousIdRow(hostPrevious[0]) : null,
    now,
  });
  return { plan, organization };
}

function unknownPreviousIds(appId: string, ids: readonly string[], registered = false): EveryAppError {
  return new EveryAppError(
    "PREVIOUS_ID_UNKNOWN",
    registered
      ? `previousIds lists ${listed(ids)}, which ${ids.length === 1 ? "isn't" : "aren't"} an id "${appId}" had on this Gateway\nA previous id says which app this one was; this Gateway knows of no such rename. Nothing was deployed.`
      : `previousIds lists ${listed(ids)}, but no app on this Gateway has ${ids.length === 1 ? "that id" : "those ids"}\nWith previousIds, a deploy renames an existing app to "${appId}"; it never creates a new one. Nothing was deployed.`,
    {
      fix: registered
        ? `drop ${listed(ids)} from previousIds in everyapp.config.ts`
        : `check the id (everyapp status lists this Gateway's apps), or remove previousIds from everyapp.config.ts to deploy "${appId}" as a new app`,
    },
  );
}

function targetExists(appId: string, others: readonly string[]): EveryAppError {
  return new EveryAppError(
    "RENAME_TARGET_EXISTS",
    `"${appId}" is already an app on this Gateway, and previousIds names another one: ${listed(others)}\nA rename moves an app to an id that is free; two apps can't be merged. Nothing was deployed.`,
    {
      fix: `pick a new id for the rename, or drop ${listed(others)} from previousIds to deploy "${appId}" as it is`,
    },
  );
}

/**
 * The rename's writes, in one batch: the app's own previous ids the new
 * id takes back go, the row takes the new id and hostname (only while it
 * still has the old id: a concurrent rename wins), and the old ones become
 * a previous id, served in full until the new hostname answers.
 */
export async function writeRename(db: D1Database, plan: RenamePlan, now: number): Promise<void> {
  const { app, from, previousId } = plan;
  const statements: D1Statement[] = [];
  if (plan.reclaimed.length > 0) {
    statements.push({
      sql: `DELETE FROM app_previous_ids WHERE app_row_id = ? AND app_slug IN (${plan.reclaimed.map(() => "?").join(", ")})`,
      params: [app.id, ...plan.reclaimed.map((row) => row.appSlug)],
    });
  }
  statements.push(
    {
      sql: `UPDATE apps SET app_slug = ?, hostname = ?, updated_at = ? WHERE id = ? AND app_slug = ? AND status <> '${DELETED_APP_STATUS}'`,
      params: [app.appSlug, app.hostname, now, app.id, from.appSlug],
    },
    {
      sql: `INSERT INTO app_previous_ids (organization_id, app_slug, app_row_id, hostname, renamed_at, moved_at, retired_at)
SELECT ?, ?, ?, ?, ?, NULL, NULL WHERE EXISTS (SELECT 1 FROM apps WHERE id = ? AND app_slug = ?)`,
      params: [
        previousId.organizationId,
        previousId.appSlug,
        previousId.appRowId,
        previousId.hostname,
        now,
        app.id,
        app.appSlug,
      ],
    },
  );
  await registryCall(() => db.run(statements));
  const [rows = []] = await db.run([{ sql: "SELECT app_slug FROM apps WHERE id = ?", params: [app.id] }]);
  if (rows[0]?.["app_slug"] !== app.appSlug) {
    throw new EveryAppError(
      "RENAME_CONFLICT",
      `${from.appSlug} changed while it was being renamed to ${app.appSlug}; nothing was renamed\nAnother deploy or delete got there first.`,
      { retryable: true },
    );
  }
}

/**
 * Bring an app's previous ids in line with the manifest's `previousIds`
 * (retire the dropped ones, serve the listed ones again). Unknown ids were
 * refused before anything was registered ({@link planRenameFor}).
 */
export async function syncPreviousIds(
  db: D1Database,
  appRowId: string,
  previousIds: readonly string[] | undefined,
  now: number,
): Promise<PreviousIdChanges & { rows: PreviousIdRow[] }> {
  const rows = await readPreviousIds(db, appRowId);
  const changes = previousIdChanges(rows, previousIds);
  const statements: D1Statement[] = [];
  const inList = (ids: string[]) => ids.map(() => "?").join(", ");
  if (changes.retire.length > 0) {
    statements.push({
      sql: `UPDATE app_previous_ids SET retired_at = ? WHERE app_row_id = ? AND retired_at IS NULL AND app_slug IN (${inList(changes.retire)})`,
      params: [now, appRowId, ...changes.retire],
    });
  }
  if (changes.restore.length > 0) {
    // Served again, in full until the next check that the app's hostname answers.
    statements.push({
      sql: `UPDATE app_previous_ids SET retired_at = NULL, moved_at = NULL WHERE app_row_id = ? AND retired_at IS NOT NULL AND app_slug IN (${inList(changes.restore)})`,
      params: [appRowId, ...changes.restore],
    });
  }
  if (statements.length > 0) await registryCall(() => db.run(statements));
  return { ...changes, rows: statements.length > 0 ? await readPreviousIds(db, appRowId) : rows };
}

/** The served previous hostnames whose page loads don't redirect yet. */
function pendingMoves(rows: readonly PreviousIdRow[]): PreviousIdRow[] {
  return rows.filter((row) => row.retiredAt === null && row.movedAt === null);
}

/** How {@link finishMoves} reaches the new hostname and waits (tests). */
interface MoveSeams {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  intervalMs?: number;
  now?: () => number;
}

const MOVE_STEP = "app.rename";

/**
 * Once the app's hostname answers over HTTPS (its certificate issued, the
 * Gateway publishing it), page loads on its served previous hostnames
 * start redirecting there (`moved_at`). Until then they serve the app in
 * full. Without `wait`, or when the hostname doesn't answer in time, they
 * stay so and the next deploy finishes it. True when every one moved.
 */
export async function finishMoves({
  db,
  appRowId,
  appId,
  hostname,
  rows,
  wait,
  out,
  seams = {},
}: {
  db: D1Database;
  appRowId: string;
  appId: string;
  hostname: string;
  rows: readonly PreviousIdRow[];
  wait: boolean;
  out: EventSink;
  seams?: MoveSeams;
}): Promise<boolean> {
  const pending = pendingMoves(rows);
  if (pending.length === 0) return true;
  const hosts = pending.map((row) => row.hostname);
  const {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxWaitMs = 600_000,
    intervalMs = 3_000,
    now = Date.now,
  } = seams;
  const notYet = (reason: string) => {
    out.emit({
      type: "warning",
      code: "RENAME_NOT_MOVED",
      step: MOVE_STEP,
      message: `${hosts.join(", ")} still ${hosts.length === 1 ? "serves" : "serve"} ${appId} without redirecting to https://${hostname}\n${reason} Deploy again once it answers to finish the move; nothing is broken meanwhile.`,
      data: { hostname, previousHostnames: hosts },
    });
    return false;
  };
  if (!wait) return notYet(`This run didn't wait for https://${hostname} to answer.`);
  const started = now();
  for (;;) {
    const answer = await probeHttps(`https://${hostname}/`, seams.fetch);
    if (answer.answered) break;
    if (now() - started >= maxWaitMs) {
      return notYet(`https://${hostname} didn't answer after ${elapsed(now() - started)} (${answer.reason}).`);
    }
    await sleep(intervalMs);
  }
  await registryCall(() =>
    db.run([
      {
        sql: `UPDATE app_previous_ids SET moved_at = ? WHERE app_row_id = ? AND retired_at IS NULL AND moved_at IS NULL`,
        params: [now(), appRowId],
      },
    ]),
  );
  out.emit({
    type: "step",
    step: MOVE_STEP,
    status: "ok",
    message: `Page loads on ${hosts.join(", ")} now redirect to https://${hostname}; API calls there are still served.`,
    data: { hostname, previousHostnames: hosts },
  });
  return true;
}

/** What the rename's confirmation shows, one line each (`describeRename`). */
export function describeRename(plan: RenamePlan, workerName: string): string[] {
  const { from, app } = plan;
  return [
    `Id         ${from.appSlug} → ${app.appSlug}`,
    `Hostname   https://${from.hostname} → https://${app.hostname}`,
    `Old host   keeps working: page loads and shared links redirect (308) to the new host once it answers;`,
    `           API calls with a bearer token, and every non-GET request, are served there as before`,
    `Kept       the Worker ${workerName} and its secrets${resourceList(plan.resources)}`,
    `Moves      who can open it, groups, tokens, AI connections, its access to OAuth connections, caps, usage, email setup`,
    `Changes    its AI tools are named ${app.appSlug}_* (were ${from.appSlug}_*); linked dev signs in again`,
  ];
}

function resourceList(resources: AppResources): string {
  const names = [
    ...Object.values(resources.d1).map((name) => `D1 ${name}`),
    ...Object.values(resources.kv).map((name) => `KV ${name}`),
    ...Object.values(resources.r2).map((name) => `R2 ${name}`),
  ];
  return names.length > 0 ? `, ${names.join(", ")}, and everything else named after it` : "";
}

