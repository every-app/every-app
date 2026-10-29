/**
 * Which Cloudflare resources each app created: `_everyapp_app_resources`
 * in the gateway's own D1, written by the CLI under the app's deploy lease
 * as it creates them (like the lease and install tables, it isn't part of
 * the gateway's schema).
 *
 * A resource's name proves nothing: anyone with the account can create a
 * D1 database, Hyperdrive config, queue, Vectorize index, AI Gateway,
 * Secrets Store secret or Worker named like an app's, and a failed first deploy
 * leaves the app registered without having created anything. So an app
 * deploy uses an existing Worker, database or namespace only when it is
 * recorded here as the app's, and `app delete --purge` deletes only what is
 * recorded here.
 */
import type { InstallationDatabase as D1Database } from "./error";
import { InstallationError as EveryAppError } from "./error";
type D1Statement = Parameters<D1Database["run"]>[0][number];

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

type ResourceKind =
  | "worker"
  | "d1"
  | "kv"
  | "hyperdrive"
  | "queue"
  | "vectorize"
  | "ai-gateway"
  | "secrets-store-secret"
  | "r2"
  | "email-route";

/** Each kind of app resource as a person reads it. */
export const RESOURCE_LABELS: Readonly<Record<ResourceKind, string>> = {
  worker: "Worker",
  d1: "D1 database",
  kv: "KV namespace",
  hyperdrive: "Hyperdrive config",
  queue: "Queue",
  vectorize: "Vectorize index",
  "ai-gateway": "AI Gateway",
  "secrets-store-secret": "Secrets Store secret",
  r2: "R2 bucket",
  "email-route": "Email Routing route for",
};

export interface OwnedResource {
  kind: ResourceKind;
  /**
   * The manifest binding; for a Worker, empty for the app's own and the
   * helper Worker's name (`workers`) for a helper; for an Email Routing
   * route, its address in the app's inbound list (`apps.email_inbound`).
   */
  binding: string;
  /** D1 name, KV title, Hyperdrive config, queue, Vectorize index, AI Gateway or Secrets Store secret name, Worker name or the route's address. */
  name: string;
  /**
   * D1 uuid, KV id, Hyperdrive config id, queue id (`queue_id`), Vectorize
   * index name (an index has no other id), AI Gateway id or Worker name; for
   * a Secrets Store secret, `<store id>/<secret id>`; for a route, its
   * rule as `<zone id>/<rule id>`, or `catch_all:<zone id>` for a zone's
   * catch-all (lib/app/emailRoutes.ts). Null while a create is in flight: the
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
    ...toOwnedResource(row),
    versionId: row["version_id"] == null ? null : String(row["version_id"]),
  }));
}

function toOwnedResource(row: Record<string, unknown>): OwnedResource {
  return {
    kind: String(row["kind"]) as ResourceKind,
    binding: String(row["binding"]),
    name: String(row["name"]),
    resourceId: row["resource_id"] === null ? null : String(row["resource_id"]),
  };
}

/**
 * Every app's records of one kind, with the Worker of the app that made
 * each: who holds an Email Routing address, say.
 */
export async function readResourcesOfKind(
  db: D1Database,
  kind: ResourceKind,
): Promise<Array<OwnedResource & { workerName: string }>> {
  const results = await db.run([
    ...CREATE_TABLE,
    {
      sql: "SELECT worker_name, binding, name, resource_id FROM _everyapp_app_resources WHERE kind = ? ORDER BY worker_name, binding",
      params: [kind],
    },
  ]);
  return (results.at(-1) ?? []).map((row) => ({
    workerName: String(row["worker_name"]),
    ...toOwnedResource({ ...row, kind }),
  }));
}

/**
 * Every app's records, of every kind, with the Worker of the app that made
 * each; empty when the table was never created. Reads only (no CREATE
 * TABLE): the teardown's inventory, which must write nothing.
 */
export async function readAllRecordedResources(
  db: D1Database,
): Promise<Array<OwnedResource & { workerName: string }>> {
  const [tables = []] = await db.run([
    {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_everyapp_app_resources'",
    },
  ]);
  if (tables.length === 0) return [];
  const [rows = []] = await db.run([
    {
      sql: "SELECT worker_name, kind, binding, name, resource_id FROM _everyapp_app_resources ORDER BY worker_name, kind, binding",
    },
  ]);
  return rows.map((row) => ({
    workerName: String(row["worker_name"]),
    ...toOwnedResource(row),
  }));
}

/**
 * The version a deploy just uploaded, recorded at once: the next unattended
 * deploy replaces only a version everyapp recorded (lib/cf/deploy.ts), even
 * when this run stops before the registry records it.
 */
export async function recordUploadedVersion(
  db: D1Database,
  workerName: string,
  versionId: string,
  /** A helper Worker's name in the manifest; the app's own Worker when empty. */
  binding = "",
): Promise<void> {
  await db.run([
    ...CREATE_TABLE,
    {
      sql: "UPDATE _everyapp_app_resources SET version_id = ? WHERE worker_name = ? AND kind = 'worker' AND binding = ?",
      params: [versionId, workerName, binding],
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
        `${describeResource(resource)} is recorded as another app's\n${workerName} can't use it.`,
        { fix: "rename the binding in everyapp.config.ts" },
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

export function describeResource({
  kind,
  name,
}: Pick<OwnedResource, "kind" | "name">): string {
  return `${RESOURCE_LABELS[kind]} "${name}"`;
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /UNIQUE constraint failed/i.test(message);
}
