/**
 * The MCP app rows the Gateway's own UI writes and reads
 * (services/McpAppService.ts): a remote MCP server's row as the registry
 * rules plan it (@every-app/perimeter/registry
 * remoteMcpApps.ts), its status, its stored block, and what the server
 * listed tool by tool (`remote_mcp_tools`, migration 0011). Its
 * credential is a provider's (`providers`, `oauth_clients`,
 * `provider_connections`), read through their own repositories. The CLI
 * writes the same rows against D1 itself (ADR-0003).
 */
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { DELETED_APP_STATUS, type AppRow } from "@every-app/perimeter/registry";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { db } from "@/db";
import { apps, appToolCatalogs, appTools, remoteMcpTools } from "@/db/schema";

type StoredApp = typeof apps.$inferSelect;

/** A stored row as the registry rules read it (`deployed_at` in epoch ms). */
export function registryRow(row: StoredApp): AppRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    appSlug: row.appSlug,
    name: row.name,
    description: row.description,
    hostname: row.hostname,
    workerName: row.workerName,
    tier: row.tier,
    scope: row.scope,
    manifest: row.manifest,
    secretNames: row.secretNames,
    status: row.status,
    versionId: row.versionId,
    deployedAt: row.deployedAt ? row.deployedAt.getTime() : null,
    deployedByActor: row.deployedByActor,
    everyone: row.everyone,
  };
}

/**
 * Write a planned remote MCP app: the row (a new one, or the id's own
 * tombstone brought back under its old row id), in one batch. A revived
 * row starts with no snapshot: anything an earlier life left is dropped
 * with it.
 */
async function writeRemoteApp(app: AppRow): Promise<void> {
  const now = new Date();
  const values = {
    id: app.id,
    organizationId: app.organizationId,
    appSlug: app.appSlug,
    name: app.name,
    description: app.description,
    hostname: app.hostname,
    workerName: app.workerName,
    tier: app.tier,
    scope: app.scope,
    manifest: app.manifest,
    status: app.status,
    versionId: app.versionId,
    deployedAt: app.deployedAt === null ? null : new Date(app.deployedAt),
    deployedByActor: app.deployedByActor,
    everyone: app.everyone,
    updatedAt: now,
  };
  const { id: _id, ...changes } = values;
  const { id, organizationId } = app;
  await db.batch([
    db
      .insert(apps)
      .values(values)
      .onConflictDoUpdate({ target: apps.id, set: changes }),
    db
      .delete(appTools)
      .where(
        and(
          eq(appTools.appRowId, id),
          eq(appTools.organizationId, organizationId),
        ),
      ),
    db
      .delete(appToolCatalogs)
      .where(
        and(
          eq(appToolCatalogs.appRowId, id),
          eq(appToolCatalogs.organizationId, organizationId),
        ),
      ),
    db
      .delete(remoteMcpTools)
      .where(
        and(
          eq(remoteMcpTools.appRowId, id),
          eq(remoteMcpTools.organizationId, organizationId),
        ),
      ),
  ]);
}

/** Store a remote app's changed block, name and description. */
async function updateRemoteApp(
  id: string,
  organizationId: string,
  change: { manifest: string; name: string; description: string },
): Promise<void> {
  await db
    .update(apps)
    .set({ ...change, updatedAt: new Date() })
    .where(and(eq(apps.id, id), eq(apps.organizationId, organizationId)));
}

/**
 * Write the name and description a remote row took from its server, only
 * while the row still has the ones they were worked out from: an admin's
 * `mcp set` in between wins. Whether a row was written.
 */
async function adoptServerNaming(
  id: string,
  organizationId: string,
  expected: { name: string; description: string },
  change: { manifest: string; name: string; description: string },
): Promise<boolean> {
  const updated = await db
    .update(apps)
    .set({ ...change, updatedAt: new Date() })
    .where(
      and(
        eq(apps.id, id),
        eq(apps.organizationId, organizationId),
        eq(apps.name, expected.name),
        eq(apps.description, expected.description),
        ne(apps.status, DELETED_APP_STATUS),
      ),
    )
    .returning({ id: apps.id });
  return updated.length > 0;
}

/** Turn an MCP app on (`active`) or off (`disabled`); a tombstone stays one. */
async function setStatus(
  id: string,
  organizationId: string,
  status: "active" | "disabled",
): Promise<void> {
  await db
    .update(apps)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(apps.id, id),
        eq(apps.organizationId, organizationId),
        ne(apps.status, DELETED_APP_STATUS),
      ),
    );
}

/**
 * What a remote server listed at the last listing, tool by tool, with the
 * risk the snapshot serves each listed one at (`app_tools`, by local
 * name), in the server's order of names.
 */
async function findListedTools(appRowId: string, organizationId: string) {
  return db
    .select({
      upstreamName: remoteMcpTools.upstreamName,
      localName: remoteMcpTools.localName,
      title: remoteMcpTools.title,
      riskHint: remoteMcpTools.riskHint,
      listed: remoteMcpTools.listed,
      problem: remoteMcpTools.problem,
      listedAt: remoteMcpTools.listedAt,
      servedRisk: appTools.risk,
      servedTitle: appTools.title,
    })
    .from(remoteMcpTools)
    .leftJoin(
      appTools,
      and(
        eq(appTools.appRowId, remoteMcpTools.appRowId),
        eq(appTools.organizationId, remoteMcpTools.organizationId),
        eq(appTools.name, remoteMcpTools.localName),
      ),
    )
    .where(
      and(
        eq(remoteMcpTools.appRowId, appRowId),
        eq(remoteMcpTools.organizationId, organizationId),
      ),
    )
    .orderBy(asc(remoteMcpTools.upstreamName));
}

/**
 * Whether another organization's remote MCP app names `providerId` as
 * its credential, a removed one's tombstone included: removing an app
 * keeps its provider row and the key bound to it, so the row stays that
 * organization's. A provider row and its key are the Gateway's, every
 * organization's at once, so an app's own row (`<appId>-mcp`) is never
 * rewritten for, or shared with, another organization's app of that id.
 */
async function providerUsedByOtherOrganization(
  providerId: string,
  organizationId: string,
): Promise<boolean> {
  const [found] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(
      and(
        eq(apps.tier, PROVIDER_APP_TIER),
        ne(apps.organizationId, organizationId),
        sql`json_valid(${apps.manifest})`,
        sql`json_extract(${apps.manifest}, '$.remote.auth.provider') = ${providerId}`,
      ),
    )
    .limit(1);
  return found !== undefined;
}

export const McpAppRepository = {
  providerUsedByOtherOrganization,
  writeRemoteApp,
  updateRemoteApp,
  adoptServerNaming,
  setStatus,
  findListedTools,
} as const;
