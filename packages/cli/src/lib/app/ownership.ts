/**
 * Which Cloudflare resources each app created: `_everyapp_app_resources`
 * in the gateway's own D1, written by the CLI under the app's deploy lease
 * as it creates them (like the lease and install tables, it isn't part of
 * the gateway's schema).
 *
 * A resource's name proves nothing: anyone with the account can create a
 * D1 database or Worker named like an app's, and a failed first deploy
 * leaves the app registered without having created anything. So an app
 * deploy uses an existing Worker, database or namespace only when it is
 * recorded here as the app's, and `app delete --purge` deletes only what is
 * recorded here. Legacy apps, whose resources the wrangler-era CLI created,
 * are recorded the first time this CLI deploys them (lib/app/resources.ts).
 */
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { CfError } from "@/lib/cf/errors";
import { EveryAppError } from "@/lib/errors";

const CREATE_TABLE: D1Statement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS _everyapp_app_resources (
  worker_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  binding TEXT NOT NULL,
  name TEXT NOT NULL,
  resource_id TEXT,
  created_at INTEGER NOT NULL,
  -- The Worker's row: the last version a deploy uploaded.
  version_id TEXT,
  PRIMARY KEY (worker_name, kind, binding)
)`,
  },
  // One resource, and one name, belongs to at most one app.
  {
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS _everyapp_app_resources_id ON _everyapp_app_resources (kind, resource_id)",
  },
  {
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS _everyapp_app_resources_name ON _everyapp_app_resources (kind, name)",
  },
];

type ResourceKind = "worker" | "d1" | "kv";

export interface OwnedResource {
  kind: ResourceKind;
  /** The manifest binding; empty for the Worker. */
  binding: string;
  /** D1 name, KV title or Worker name. */
  name: string;
  /**
   * D1 uuid, KV id or Worker name. Null while a create is in flight: the
   * name was free when the claim was written, so a resource that has the
   * name now is the one this app created.
   */
  resourceId: string | null;
  /** The Worker's record: the version a deploy last uploaded. */
  versionId?: string | null;
}

/** What the app with this Worker recorded as its own. */
export async function readOwnedResources(
  db: D1Database,
  workerName: string,
): Promise<OwnedResource[]> {
  const results = await db.run([
    ...CREATE_TABLE,
    {
      sql: "SELECT kind, binding, name, resource_id, version_id FROM _everyapp_app_resources WHERE worker_name = ? ORDER BY kind, binding",
      params: [workerName],
    },
  ]);
  return (results.at(-1) ?? []).map((row) => ({
    kind: String(row["kind"]) as ResourceKind,
    binding: String(row["binding"]),
    name: String(row["name"]),
    resourceId: row["resource_id"] === null ? null : String(row["resource_id"]),
    versionId: row["version_id"] == null ? null : String(row["version_id"]),
  }));
}

/**
 * The version a deploy just uploaded, recorded at once: the next unattended
 * deploy replaces only a version everyapp recorded (lib/cf/deploy.ts), even
 * when this run stops before the gateway hears about it.
 */
export async function recordUploadedVersion(
  db: D1Database,
  workerName: string,
  versionId: string,
): Promise<void> {
  await db.run([
    ...CREATE_TABLE,
    {
      sql: "UPDATE _everyapp_app_resources SET version_id = ? WHERE worker_name = ? AND kind = 'worker'",
      params: [versionId, workerName],
    },
  ]);
}

/** Record a resource as the app's (replacing what its binding had). */
export async function recordOwnedResource(
  db: D1Database,
  workerName: string,
  resource: OwnedResource,
): Promise<void> {
  try {
    await db.run([
      ...CREATE_TABLE,
      {
        sql: `INSERT INTO _everyapp_app_resources (worker_name, kind, binding, name, resource_id, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (worker_name, kind, binding) DO UPDATE SET name = excluded.name,
  resource_id = excluded.resource_id`,
        params: [
          workerName,
          resource.kind,
          resource.binding,
          resource.name,
          resource.resourceId,
          Date.now(),
        ],
      },
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new EveryAppError(
        "RESOURCE_OWNED",
        `${describeResource(resource)} is recorded as another app's, so ${workerName} can't use it. Rename the binding in everyapp.config.ts.`,
      );
    }
    throw error;
  }
}

/** Forget an app's records, all of them or one binding's. */
export async function forgetOwnedResources(
  db: D1Database,
  workerName: string,
  only?: Pick<OwnedResource, "kind" | "binding">,
): Promise<void> {
  await db.run([
    ...CREATE_TABLE,
    only
      ? {
          sql: "DELETE FROM _everyapp_app_resources WHERE worker_name = ? AND kind = ? AND binding = ?",
          params: [workerName, only.kind, only.binding],
        }
      : {
          sql: "DELETE FROM _everyapp_app_resources WHERE worker_name = ?",
          params: [workerName],
        },
  ]);
}

/**
 * The app whose Worker has this name, deleted or not: its `DB` and `KV`
 * have that name too. A legacy app's other bindings are named
 * `every-<appId>-<binding>`, which can be another legacy app's Worker
 * name (`notes`'s ARCHIVE and app `notes-archive`), so a resource with
 * such a name is never created, adopted or purged for the first app.
 */
export async function appWithWorkerNamed(
  db: D1Database,
  name: string,
): Promise<string | null> {
  const [rows = []] = await db.run([
    {
      sql: "SELECT app_slug FROM apps WHERE worker_name = ? LIMIT 1",
      params: [name],
    },
  ]);
  return rows[0] ? String(rows[0]["app_slug"]) : null;
}

export function describeResource({
  kind,
  name,
}: Pick<OwnedResource, "kind" | "name">): string {
  const label =
    kind === "worker"
      ? "Worker"
      : kind === "d1"
        ? "D1 database"
        : "KV namespace";
  return `${label} "${name}"`;
}

function isUniqueViolation(error: unknown): boolean {
  const message =
    error instanceof CfError || error instanceof Error ? error.message : "";
  return /UNIQUE constraint failed/i.test(message);
}
