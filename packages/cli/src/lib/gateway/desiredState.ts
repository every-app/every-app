/**
 * Which app Workers the gateway should bind, read from its registry: apps
 * that are uploaded (`binding`), live (`active`) or switched off
 * (`disabled`, still bound so turning it on again is instant). `pending`
 * apps are never bound, since their Worker may not exist yet. A row is bound
 * only if its Worker is the one the naming rule gives it
 * (`every-<orgKey>-<appId>`), so the registry can never point the gateway
 * at another Worker in the account, and only if
 * that Worker exists: a deploy moves a row to `binding` on the CLI's
 * word, and an `active` row outlives a Worker deleted by hand. Binding a
 * missing Worker fails the whole gateway deploy, so one stale row would
 * hold up every app.
 */
import {
  appBindingName,
  appBindingsDigest,
  isRegistryWorkerName,
} from "@every-app/perimeter/manifest";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";

const DESIRED_APPS = `SELECT apps.app_slug, apps.worker_name, apps.hostname, apps.status,
  organization_keys.org_key
FROM apps LEFT JOIN organization_keys
  ON organization_keys.organization_id = apps.organization_id
WHERE apps.status IN ('binding', 'active', 'disabled')
  AND apps.worker_name IS NOT NULL AND apps.hostname IS NOT NULL
ORDER BY apps.worker_name`;

interface BoundApp {
  appId: string;
  workerName: string;
  hostname: string;
  status: string;
}

export interface DesiredState {
  apps: BoundApp[];
  /** Sorted, unique. */
  appWorkers: string[];
  /** The bound apps' hostnames, sorted, unique. */
  appHosts: string[];
  /** Of the APP__ binding names: two states bind the same Workers when it matches. */
  appBindingsDigest: string;
  /** Rows not bound because their Worker name breaks the naming rule. */
  skipped: Array<{ appId: string; workerName: string }>;
  /** Rows not bound because their Worker doesn't exist. */
  missing: Array<{ appId: string; workerName: string }>;
}

/** Whether a Worker exists, asked once per Worker for a whole deploy. */
export function workerExistence(
  cf: CfRunner,
): (workerName: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  return (workerName) => {
    let exists = known.get(workerName);
    if (!exists) {
      exists = getWorkerDeployment(cf, workerName).then(
        (deployment) => deployment !== null,
      );
      known.set(workerName, exists);
    }
    return exists;
  };
}

const EXISTENCE_CHECKS_AT_ONCE = 4;

export async function readDesiredState(
  db: D1Database,
  workerExists: (workerName: string) => Promise<boolean>,
): Promise<DesiredState> {
  const [rows = []] = await db.run([{ sql: DESIRED_APPS }]);
  const named: BoundApp[] = [];
  const skipped: DesiredState["skipped"] = [];
  for (const row of rows) {
    const app = {
      appId: String(row["app_slug"]),
      workerName: String(row["worker_name"]),
      hostname: String(row["hostname"]),
      status: String(row["status"]),
    };
    const valid = isRegistryWorkerName({
      appId: app.appId,
      workerName: app.workerName,
      orgKey: typeof row["org_key"] === "string" ? row["org_key"] : null,
    });
    if (valid) named.push(app);
    else skipped.push({ appId: app.appId, workerName: app.workerName });
  }

  const exists: boolean[] = [];
  for (let i = 0; i < named.length; i += EXISTENCE_CHECKS_AT_ONCE) {
    const batch = named.slice(i, i + EXISTENCE_CHECKS_AT_ONCE);
    exists.push(...(await Promise.all(batch.map((app) => workerExists(app.workerName)))));
  }
  const apps = named.filter((_app, index) => exists[index]);
  const missing = named
    .filter((_app, index) => !exists[index])
    .map(({ appId, workerName }) => ({ appId, workerName }));

  const appWorkers = [...new Set(apps.map((app) => app.workerName))].sort();
  return {
    apps,
    appWorkers,
    appHosts: [...new Set(apps.map((app) => app.hostname.toLowerCase()))].sort(),
    appBindingsDigest: await appBindingsDigest(appWorkers.map(appBindingName)),
    skipped,
    missing,
  };
}

/** Whether two desired states bind the same Workers, at the same hosts. */
export function sameBindings(a: DesiredState, b: DesiredState): boolean {
  return (
    a.appBindingsDigest === b.appBindingsDigest &&
    a.appHosts.join("\n") === b.appHosts.join("\n")
  );
}
