/**
 * The MCP app rows the Gateway's own UI writes and reads
 * (services/McpAppService.ts): a remote MCP server's row and its grants as
 * the registry rules plan them (@every-app/perimeter/registry
 * remoteMcpApps.ts), its status, its stored block, and what the server
 * listed tool by tool (`remote_mcp_tools`) and which origin its credential
 * is bound to (`remote_mcp_credentials`), both migration 0011. The CLI
 * writes the same rows against D1 itself (ADR-0003).
 */
import { and, asc, eq, ne } from "drizzle-orm";
import {
  DELETED_APP_STATUS,
  type AccessGrant,
  type AppRow,
} from "@every-app/perimeter/registry";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { db } from "@/db";
import {
  apps,
  appToolCatalogs,
  appTools,
  remoteMcpCredentials,
  remoteMcpTools,
  userAppAccess,
} from "@/db/schema";

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
    isDefault: row.isDefault,
  };
}

/**
 * Every live MCP app row on this Gateway, every organization's (the
 * Gateway has one set of secrets): which origin each remote app sends
 * which credential name to is read from their manifests.
 */
async function findLiveProviderManifests(): Promise<
  { organizationId: string; appSlug: string; manifest: string | null }[]
> {
  return db
    .select({
      organizationId: apps.organizationId,
      appSlug: apps.appSlug,
      manifest: apps.manifest,
    })
    .from(apps)
    .where(
      and(
        eq(apps.tier, PROVIDER_APP_TIER),
        ne(apps.status, DELETED_APP_STATUS),
      ),
    );
}

/**
 * Write a planned remote MCP app: the row (a new one, or the id's own
 * tombstone brought back under its old row id) and its grants, one per
 * statement (D1 binds at most 100 parameters each), in one batch. A
 * revived row starts with no snapshot: anything an earlier life left is
 * dropped with it.
 */
async function writeRemoteApp(
  app: AppRow,
  grants: readonly AccessGrant[],
): Promise<void> {
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
    isDefault: app.isDefault,
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
    ...grants.map((grant) =>
      db.insert(userAppAccess).values(grant).onConflictDoNothing(),
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

/** The origin a credential name is bound to, or null when it isn't. */
async function findCredentialBinding(name: string): Promise<string | null> {
  const [row] = await db
    .select({ origin: remoteMcpCredentials.origin })
    .from(remoteMcpCredentials)
    .where(eq(remoteMcpCredentials.name, name))
    .limit(1);
  return row?.origin ?? null;
}

export const McpAppRepository = {
  findLiveProviderManifests,
  writeRemoteApp,
  updateRemoteApp,
  setStatus,
  findListedTools,
  findCredentialBinding,
} as const;
