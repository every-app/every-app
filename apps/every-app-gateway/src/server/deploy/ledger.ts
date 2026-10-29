/**
 * The D1 databases the hosted deployer created, recorded in
 * the CLI's resource ledger (`_everyapp_app_resources` in the gateway's
 * D1, packages/cli/src/lib/app/ownership.ts) with the same rules: a name
 * proves nothing (anyone with the account can create a database named like
 * an app's), so a deploy uses a database only when the ledger records it as
 * that app's, and a name recorded for another app is refused. Like the
 * CLI, the gateway creates the table when it first needs it: it isn't part
 * of the gateway's schema.
 */
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { DeployError } from "./errors";
import type { DeployerPort } from "./port";

const CREATE_TABLE = [
  sql`CREATE TABLE IF NOT EXISTS _everyapp_app_resources (
  worker_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  binding TEXT NOT NULL,
  name TEXT NOT NULL,
  resource_id TEXT,
  created_at INTEGER NOT NULL,
  version_id TEXT,
  PRIMARY KEY (worker_name, kind, binding)
)`,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS _everyapp_app_resources_id ON _everyapp_app_resources (kind, resource_id)`,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS _everyapp_app_resources_name ON _everyapp_app_resources (kind, name)`,
];

async function ensureTable(): Promise<void> {
  for (const statement of CREATE_TABLE) await db.run(statement);
}

async function recorded(
  workerName: string,
  binding: string,
): Promise<{ name: string; resourceId: string | null } | null> {
  const [row] = (await db.all(
    sql`SELECT name, resource_id FROM _everyapp_app_resources WHERE worker_name = ${workerName} AND kind = 'd1' AND binding = ${binding}`,
  )) as Array<{ name: string; resource_id: string | null }>;
  return row ? { name: row.name, resourceId: row.resource_id } : null;
}

async function record(
  workerName: string,
  binding: string,
  name: string,
  resourceId: string | null,
): Promise<void> {
  try {
    await db.run(
      sql`INSERT INTO _everyapp_app_resources (worker_name, kind, binding, name, resource_id, created_at)
VALUES (${workerName}, 'd1', ${binding}, ${name}, ${resourceId}, ${Date.now()})
ON CONFLICT (worker_name, kind, binding) DO UPDATE SET name = excluded.name, resource_id = excluded.resource_id`,
    );
  } catch (error) {
    if (
      /UNIQUE constraint failed/i.test(String((error as Error)?.message ?? ""))
    ) {
      throw new DeployError(
        "RESOURCE_OWNED",
        409,
        `D1 database "${name}" is recorded as another app's, so ${workerName} can't use it. Rename the binding in everyapp.config.ts.`,
      );
    }
    throw error;
  }
}

/**
 * The app's D1 database for `binding`, named `name`, decided as the CLI
 * decides (packages/cli/src/lib/app/resources.ts): the one the ledger
 * records; or, when a deploy claimed the name and stopped before it
 * recorded the id, the database that has the name now (the name was free
 * when it was claimed, so that is the one its create made); or a new one,
 * claimed before it is created (recreated, empty, when the recorded one is
 * gone). A database with the name that the ledger doesn't give this app is
 * refused.
 */
export async function ensureAppDatabase(
  deployer: DeployerPort,
  {
    workerName,
    binding,
    name,
  }: { workerName: string; binding: string; name: string },
): Promise<{ id: string; created: boolean }> {
  await ensureTable();
  const existing = await recorded(workerName, binding);
  const claim = existing?.name === name ? existing : null;
  const found = await deployer.findDatabase(name);
  if (claim?.resourceId) {
    if (found === claim.resourceId) return { id: found, created: false };
    if (found) {
      throw new DeployError(
        "RESOURCE_REPLACED",
        409,
        `D1 database "${name}" isn't the one ${workerName}'s deploys created (${claim.resourceId}): that one was deleted, and this one created since. The gateway's operators need to look.`,
      );
    }
  } else if (claim) {
    if (found) {
      await record(workerName, binding, name, found);
      return { id: found, created: false };
    }
  } else {
    if (found) {
      throw new DeployError(
        "RESOURCE_NAME_TAKEN",
        409,
        `A D1 database named "${name}" already exists, but no deploy of ${workerName} created it. The gateway's operators need to look.`,
      );
    }
    await record(workerName, binding, name, null);
  }
  const id = await deployer.createDatabase(name);
  await record(workerName, binding, name, id);
  return { id, created: true };
}
