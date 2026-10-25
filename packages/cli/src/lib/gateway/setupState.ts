/**
 * An app's setup state on its registry row (`apps.setup_state`, migration
 * 0012: `ready`, `needs_setup`, or null for never evaluated) and the
 * `app.needs_setup` and `app.ready` events of its transitions
 * (docs/design/2026-10-events-out.md, section 5). The Gateway writes it
 * wherever it evaluates readiness; the CLI writes it after `configure`,
 * `secret set|unset` and `deploy` compute an app's setup, with the event in
 * the same D1 batch as the change of state.
 *
 * A first evaluation that finds the app ready says nothing (an app that
 * never needed anything isn't news); one that finds it needing setup says
 * so. A setup that reads ready only because some setting's state is
 * unknown (cf couldn't list a Worker's secrets, an app's names were never
 * recorded) is no evaluation: the stored state is left as it is. The
 * write is a compare-and-set on the state it read, and the event rides on
 * that write having happened, so the Gateway and the CLI evaluating at once
 * never announce one transition twice. Nothing here throws to the command:
 * the setting it reports on is set either way.
 */
import { DELETED_APP_STATUS, parseSecretNames } from "@every-app/perimeter/registry";
import { PROVIDER_APP_TIER, type AppSetup, type SettingsManifestLike } from "@every-app/sdk/internal";
import { appSetupFrom, gatewayNamesRead, listGatewaySecretNames } from "@/lib/app/settings";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { errorMessage } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { hasEventsTables, operatorActor, queueEventFromCli } from "./events";
import { text, type Deployer } from "./registry";

type SetupState = "ready" | "needs_setup";

/**
 * The state a setup says, or null when it says nothing for sure: ready
 * while a setting the app can't do without reads unknown.
 */
export function setupStateOf(setup: AppSetup): SetupState | null {
  if (!setup.ready) return "needs_setup";
  const unknown = setup.settings.some(
    (setting) => setting.set === null && setting.names.length > 0 && setting.need.kind !== "optional",
  );
  return unknown ? null : "ready";
}

/** The names of the settings that keep the app closed, each once, in manifest order: `data.unmet`. */
export function unmetNames(setup: AppSetup): string[] {
  return [...new Set(setup.unmet.flatMap((setting) => setting.names))];
}

interface Recorded {
  state: SetupState;
  previous: SetupState | null;
  /** The event queued with the change, if the change is one. */
  event: "app.needs_setup" | "app.ready" | null;
}

/** What the state's write needs of the app's row. */
interface StateRow {
  id: string;
  organizationId: string;
  appSlug: string;
  name: string;
  status: string;
  setupState: string | null;
}

const STATE_COLUMNS = "id, organization_id, app_slug, name, status, setup_state";

const toStateRow = (row: Record<string, unknown>): StateRow => ({
  id: String(row["id"]),
  organizationId: String(row["organization_id"]),
  appSlug: String(row["app_slug"]),
  name: String(row["name"]),
  status: String(row["status"]),
  setupState: row["setup_state"] == null ? null : String(row["setup_state"]),
});

/**
 * Record one app's state from a setup the command computed: written when
 * it differs from the stored one, with `app.needs_setup` (unmet names
 * only) or `app.ready` when that is a transition. Null when nothing could
 * be recorded: a Gateway from before the column, an app gone, a setup that
 * isn't sure. `row` is the app's row when the caller read it already.
 */
export async function recordSetupState(
  db: D1Database,
  input: { appRowId: string; setup: AppSetup; deployer: Deployer; now?: number; row?: StateRow },
): Promise<Recorded | null> {
  if (!(await hasEventsTables(db))) return null;
  const state = setupStateOf(input.setup);
  if (!state) return null;
  const row = input.row ?? (await readStateRow(db, input.appRowId));
  if (!row || row.status === DELETED_APP_STATUS) return null;
  const previous: SetupState | null =
    row.setupState === "ready" || row.setupState === "needs_setup" ? row.setupState : null;
  if (previous === state) return { state, previous, event: null };
  const event =
    state === "needs_setup" ? "app.needs_setup" : previous === "needs_setup" ? "app.ready" : null;
  const app = { id: row.appSlug, rowId: row.id, name: row.name };
  const queued = event
    ? await queueEventFromCli(db, {
        organizationId: row.organizationId,
        type: event,
        actor: operatorActor(input.deployer),
        data: event === "app.needs_setup" ? { app, unmet: unmetNames(input.setup) } : { app },
        appRowId: row.id,
        // Right after the compare-and-set below: only when it changed the row.
        onlyIf: { sql: "changes() > 0", params: [] },
        now: input.now,
      })
    : [];
  await db.run([
    {
      sql: "UPDATE apps SET setup_state = ? WHERE id = ? AND setup_state IS ?",
      params: [state, row.id, previous],
    },
    ...queued,
  ]);
  return { state, previous, event };
}

async function readStateRow(db: D1Database, appRowId: string): Promise<StateRow | null> {
  const [rows = []] = await db.run([{ sql: `SELECT ${STATE_COLUMNS} FROM apps WHERE id = ?`, params: [appRowId] }]);
  return rows[0] ? toStateRow(rows[0]) : null;
}

/**
 * After Gateway settings or an app's own secrets changed (`secret
 * set|unset`, `configure`, `access on|off`): record the state of every app
 * the change can move, from the manifest its last deploy stored, the
 * Gateway's names as cf lists them now, and each app's recorded secret
 * names (the changed app's were recorded just before). Apps that read none
 * of the changed Gateway names, provider and dispatch apps, and apps never
 * deployed are left out; with none left, the Gateway's names aren't
 * listed. One read for every row; a write only for a state that changed.
 * `except` is an app the caller records itself. A failure is said under
 * --verbose and swallowed.
 */
export async function refreshSetupStates(
  connection: { cf: CfRunner; db: D1Database; deployer: Deployer },
  changed: { gateway: readonly string[]; appRowId: string | null; except?: string },
  out: EventSink,
): Promise<void> {
  try {
    const { cf, db, deployer } = connection;
    if (changed.gateway.length === 0 && changed.appRowId === null) return;
    if (!(await hasEventsTables(db))) return;
    // The event tables came with setup_state, after secret_names: both are there.
    const [rows = []] = await db.run([
      {
        sql: `SELECT ${STATE_COLUMNS}, tier, manifest, secret_names FROM apps
WHERE status NOT IN ('${DELETED_APP_STATUS}', 'pending') AND tier NOT IN ('${PROVIDER_APP_TIER}', 'dispatch')`,
      },
    ]);
    const apps = rows.flatMap((row) => {
      const manifest = parsed<SettingsManifestLike>(row["manifest"]);
      if (!manifest || typeof manifest !== "object" || row["id"] === changed.except) return [];
      const moved =
        row["id"] === changed.appRowId ||
        gatewayNamesRead(manifest).some((name) => changed.gateway.includes(name));
      return moved ? [{ row: toStateRow(row), manifest, secretNames: parseSecretNames(text(row["secret_names"])) }] : [];
    });
    if (apps.length === 0) return;
    const gatewayNames = await listGatewaySecretNames(cf);
    for (const app of apps) {
      const { setup } = appSetupFrom({
        manifest: app.manifest,
        appId: app.row.appSlug,
        gatewayNames,
        secretNames: app.secretNames,
      });
      await recordSetupState(db, { appRowId: app.row.id, setup, deployer, row: app.row });
    }
  } catch (error) {
    out.emit({
      type: "progress",
      step: "app.setup_state",
      message: `Couldn't record whether the apps are set up (${errorMessage(error).split("\n")[0]}); the Gateway records it when it next lists them`,
    });
  }
}

/** A JSON column as a value, or null when it doesn't parse. */
function parsed<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** {@link recordSetupState} for a command that must not fail on it: a failure is said under --verbose. */
export async function recordSetupStateQuietly(
  db: D1Database,
  input: Parameters<typeof recordSetupState>[1],
  out: EventSink,
): Promise<void> {
  try {
    await recordSetupState(db, input);
  } catch (error) {
    out.emit({
      type: "progress",
      step: "app.setup_state",
      message: `Couldn't record whether the app is set up (${errorMessage(error).split("\n")[0]}); the Gateway records it when it next lists it`,
    });
  }
}
