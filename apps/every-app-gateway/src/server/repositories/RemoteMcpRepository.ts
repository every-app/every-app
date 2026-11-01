import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  apps,
  appToolCatalogs,
  remoteMcpCredentials,
  remoteMcpTools,
} from "@/db/schema";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import type { RemoteToolRecord } from "@every-app/toolbus/remote";

/** D1 binds at most 100 parameters a statement; a tools row binds 9. */
const TOOL_ROWS_PER_INSERT = 11;

interface CredentialBinding {
  name: string;
  origin: string;
  boundBy: string | null;
  boundAt: Date;
}

/** Which origin a credential name was set for, if recorded. */
async function findCredentialBinding(
  name: string,
): Promise<CredentialBinding | null> {
  const [row] = await db
    .select()
    .from(remoteMcpCredentials)
    .where(eq(remoteMcpCredentials.name, name))
    .limit(1);
  return row ?? null;
}

/** Replace what a remote server listed for one app row, in one batch. */
async function replaceTools(
  appRowId: string,
  organizationId: string,
  records: readonly RemoteToolRecord[],
  listedAt = new Date(),
): Promise<void> {
  const rows = records.map((record) => ({
    appRowId,
    organizationId,
    upstreamName: record.upstreamName,
    localName: record.localName,
    title: record.title,
    riskHint: record.riskHint,
    listed: record.listed,
    problem: record.problem,
    listedAt,
  }));
  const inserts = [];
  for (let index = 0; index < rows.length; index += TOOL_ROWS_PER_INSERT) {
    inserts.push(
      db
        .insert(remoteMcpTools)
        .values(rows.slice(index, index + TOOL_ROWS_PER_INSERT)),
    );
  }
  await db.batch([
    db.delete(remoteMcpTools).where(eq(remoteMcpTools.appRowId, appRowId)),
    ...inserts,
  ]);
}

async function findToolsByApp(appRowId: string) {
  return db
    .select()
    .from(remoteMcpTools)
    .where(eq(remoteMcpTools.appRowId, appRowId))
    .orderBy(asc(remoteMcpTools.upstreamName));
}

interface StaleRemoteApp {
  rowId: string;
  organizationId: string;
  appSlug: string;
  name: string;
  manifest: string | null;
}

/**
 * Active remote MCP apps whose snapshot is older than `olderThan`, or
 * missing: the hourly re-list's work, oldest first. A remote app's row is
 * a provider-tier row whose manifest has a `remote` block.
 */
async function findStaleRemoteApps(
  olderThan: Date,
  limit: number,
): Promise<StaleRemoteApp[]> {
  const rows = await db
    .select({
      rowId: apps.id,
      organizationId: apps.organizationId,
      appSlug: apps.appSlug,
      name: apps.name,
      manifest: apps.manifest,
    })
    .from(apps)
    .leftJoin(
      appToolCatalogs,
      and(
        eq(appToolCatalogs.appRowId, apps.id),
        eq(appToolCatalogs.organizationId, apps.organizationId),
      ),
    )
    .where(
      and(
        eq(apps.tier, PROVIDER_APP_TIER),
        eq(apps.status, "active"),
        sql`json_valid(${apps.manifest})`,
        sql`json_extract(${apps.manifest}, '$.remote') IS NOT NULL`,
        or(
          isNull(appToolCatalogs.appRowId),
          lt(appToolCatalogs.fetchedAt, olderThan),
        ),
      ),
    )
    .orderBy(asc(appToolCatalogs.fetchedAt), asc(apps.appSlug))
    .limit(limit);
  return rows;
}

/**
 * The origin another live MCP app sends a credential name to, if one
 * does (any organization: the gateway has one set of secrets), for the
 * registry rule that keeps a name bound to one origin.
 */
async function originUsingSecret(
  name: string,
  exceptRowId?: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: apps.id, manifest: apps.manifest })
    .from(apps)
    .where(
      and(
        eq(apps.tier, PROVIDER_APP_TIER),
        sql`${apps.status} != 'deleted'`,
        sql`json_valid(${apps.manifest})`,
        sql`json_extract(${apps.manifest}, '$.remote.auth.secret') = ${name}`,
      ),
    )
    .limit(5);
  for (const row of rows) {
    if (exceptRowId && row.id === exceptRowId) continue;
    try {
      const url = (
        JSON.parse(row.manifest ?? "{}") as { remote?: { url?: string } }
      ).remote?.url;
      if (url) return new URL(url).origin;
    } catch {
      // An unreadable row binds nothing.
    }
  }
  return null;
}

export const RemoteMcpRepository = {
  findCredentialBinding,
  replaceTools,
  findToolsByApp,
  findStaleRemoteApps,
  originUsingSecret,
} as const;
