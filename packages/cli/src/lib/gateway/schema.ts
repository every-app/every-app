/**
 * The one version check between this everyapp and the Gateway it acts on:
 * the Gateway's database has every migration this everyapp's Gateway has
 * (its newest, `cf d1 migrations apply`'s `d1_migrations` row). The CLI
 * and the Gateway are one release, and the CLI reads and writes the
 * Gateway's tables directly, so a Gateway behind it is refused before
 * anything is read (GATEWAY_OUTDATED; `update` brings it up). A Gateway
 * ahead of this everyapp is fine: Gateway migrations only add.
 */
import journal from "../../../../../apps/every-app-gateway/drizzle/meta/_journal.json";
import type { D1Database } from "@/lib/cf/d1";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";

/** The newest Gateway migration at this everyapp's commit: what its commands need. */
export const GATEWAY_SCHEMA: string = journal.entries.reduce((newest, entry) =>
  entry.when > newest.when ? entry : newest,
).tag;

/**
 * Whether the Gateway's database has {@link GATEWAY_SCHEMA}. One query; a
 * live Gateway has `d1_migrations` (its first deploy migrated before it
 * uploaded), and one without it is as outdated as can be.
 */
export async function hasGatewaySchema(db: D1Database): Promise<boolean> {
  try {
    const [applied = []] = await db.run([
      { sql: "SELECT name FROM d1_migrations WHERE name = ?", params: [`${GATEWAY_SCHEMA}.sql`] },
    ]);
    return applied.length > 0;
  } catch (error) {
    if (/no such table: d1_migrations/.test(errorMessage(error))) return false;
    throw error;
  }
}

/** GATEWAY_OUTDATED unless the Gateway's database has {@link GATEWAY_SCHEMA}. */
export async function requireGatewaySchema(
  db: D1Database,
  /** Which Gateway it is, for the update a person at a terminal is offered (./offerUpdate.ts). */
  gateway?: { gatewayUrl: string; accountId: string },
): Promise<void> {
  if (await hasGatewaySchema(db)) return;
  throw new EveryAppError(
    "GATEWAY_OUTDATED",
    `The Gateway is older than this everyapp\nIts database doesn't have migration ${GATEWAY_SCHEMA} yet, which this everyapp reads and writes.`,
    {
      rerun: `${CLI} update`,
      rerunNote: "then run this again",
      data: { needs: GATEWAY_SCHEMA, ...gateway },
    },
  );
}
