import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { apps, appToolCatalogs, remoteMcpTools } from "@/db/schema";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import type { RemoteToolRecord } from "@every-app/toolbus/remote";

/** D1 binds at most 100 parameters a statement; a tools row binds 9. */
const TOOL_ROWS_PER_INSERT = 11;

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

export const RemoteMcpRepository = {
  replaceTools,
  findToolsByApp,
  findStaleRemoteApps,
} as const;
