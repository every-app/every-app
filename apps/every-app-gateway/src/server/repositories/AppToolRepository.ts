import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import {
  apps,
  appToolCatalogs,
  appTools,
  mcpConnectionApps,
} from "@/db/schema";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import type { ToolBusTool } from "@every-app/toolbus";
import { accessToApp } from "./effective-access";

export type CatalogStatus = "ok" | "empty" | "unsupported" | "error";

export type StoredCatalog = {
  appRowId: string;
  status: CatalogStatus;
  catalogHash: string | null;
  instructions: string | null;
  /** When it was taken; for a catalog that isn't serving, the last try. */
  fetchedAt: Date;
  /** The app version it was taken from (or last tried). */
  versionId: string | null;
  /** The app's version now (`apps.version_id`). */
  appVersionId: string | null;
  tools: ToolBusTool[];
};

type ReplaceCatalogInput = {
  appRowId: string;
  organizationId: string;
  /** The app version the catalog was taken from. */
  versionId: string | null;
  status: CatalogStatus;
  catalogHash: string | null;
  instructions: string | null;
  sdkVersion: string | null;
  warnings: string[];
  lastError: string | null;
  tools: ToolBusTool[];
};

/**
 * Rows per INSERT of the snapshot write ({@link replace}). D1 binds at most
 * 100 parameters per statement (developers.cloudflare.com/d1/platform/limits,
 * "Bound parameters per query", read 2026-10-24); app_tools has 10 columns,
 * so 9 rows bind 90.
 */
const TOOL_ROWS_PER_INSERT = 9;

/** One app the gateway /mcp serves a caller, with its snapshot. */
type VisibleCatalog = {
  appRowId: string;
  /** The organization the app belongs to (a shared app's: the platform's). */
  organizationId: string;
  appSlug: string;
  name: string;
  description: string;
  /** Null for a provider app (tier "provider"), which the gateway serves itself. */
  hostname: string | null;
  workerName: string | null;
  tier: string;
  versionId: string | null;
  /** The stored manifest's JSON and recorded secret names: whether the app needs setup. */
  manifest: string | null;
  secretNames: string | null;
  catalogHash: string;
  instructions: string | null;
  tools: ToolBusTool[];
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * The catalog of an app, looked up by the routing pair the perimeter
 * resolves (organization + app slug), or null when it was never synced.
 */
async function findByOrgApp(
  organizationId: string,
  appSlug: string,
): Promise<StoredCatalog | null> {
  const [catalogRows, toolRows] = await db.batch([
    db
      .select({
        appRowId: appToolCatalogs.appRowId,
        status: appToolCatalogs.status,
        catalogHash: appToolCatalogs.catalogHash,
        instructions: appToolCatalogs.instructions,
        fetchedAt: appToolCatalogs.fetchedAt,
        versionId: appToolCatalogs.versionId,
        appVersionId: apps.versionId,
      })
      .from(appToolCatalogs)
      .innerJoin(
        apps,
        and(
          eq(apps.id, appToolCatalogs.appRowId),
          eq(apps.organizationId, appToolCatalogs.organizationId),
        ),
      )
      .where(
        and(eq(apps.organizationId, organizationId), eq(apps.appSlug, appSlug)),
      )
      .limit(1),
    db
      .select({
        name: appTools.name,
        title: appTools.title,
        description: appTools.description,
        risk: appTools.risk,
        inputSchema: appTools.inputSchema,
        outputSchema: appTools.outputSchema,
        annotations: appTools.annotations,
        catalogHash: appTools.catalogHash,
      })
      .from(appTools)
      .innerJoin(
        apps,
        and(
          eq(apps.id, appTools.appRowId),
          eq(apps.organizationId, appTools.organizationId),
        ),
      )
      .where(
        and(eq(apps.organizationId, organizationId), eq(apps.appSlug, appSlug)),
      )
      .orderBy(asc(appTools.name)),
  ]);

  const catalog = catalogRows[0];
  if (!catalog) return null;
  return {
    appRowId: catalog.appRowId,
    status: catalog.status as CatalogStatus,
    catalogHash: catalog.catalogHash,
    instructions: catalog.instructions,
    fetchedAt: catalog.fetchedAt,
    versionId: catalog.versionId,
    appVersionId: catalog.appVersionId,
    tools: toolRows
      // Rows are replaced atomically; the hash check only guards a reader
      // that raced a sync between the two selects.
      .filter((row) => row.catalogHash === catalog.catalogHash)
      .map(toToolBusTool),
  };
}

type StoredToolRow = {
  name: string;
  title: string | null;
  description: string;
  risk: string;
  inputSchema: string;
  outputSchema: string | null;
  annotations: string | null;
};

function toToolBusTool(row: StoredToolRow): ToolBusTool {
  return {
    name: row.name,
    ...(row.title ? { title: row.title } : {}),
    description: row.description,
    risk: row.risk as ToolBusTool["risk"],
    inputSchema: parseJson(row.inputSchema, {}),
    ...(row.outputSchema
      ? { outputSchema: parseJson(row.outputSchema, {}) }
      : {}),
    ...(row.annotations ? { annotations: parseJson(row.annotations, {}) } : {}),
  };
}

type VisibilityScope = {
  organizationId: string;
  userId: string;
  /** The platform policy's: shared apps reach every organization's members. */
  sharedApps: boolean;
  /** A connection that chose its apps. */
  connectionId?: string;
  /** A token bound to one app. */
  appRowId?: string;
};

/**
 * The active apps a caller reaches: their organization's they have access
 * to (directly or through a group, {@link accessToApp}) and the shared
 * apps, narrowed to the scope's choice.
 */
function reachableApps(scope: VisibilityScope): SQL[] {
  const own = and(
    eq(apps.organizationId, scope.organizationId),
    accessToApp(scope.userId, scope.organizationId),
  )!;
  return [
    scope.sharedApps ? or(own, eq(apps.scope, "shared"))! : own,
    eq(apps.status, "active"),
    // Routable, or a provider app the gateway serves itself.
    or(
      and(isNotNull(apps.hostname), isNotNull(apps.workerName)),
      eq(apps.tier, PROVIDER_APP_TIER),
    )!,
    ...(scope.connectionId
      ? [
          inArray(
            apps.id,
            db
              .select({ appRowId: mcpConnectionApps.appRowId })
              .from(mcpConnectionApps)
              .where(eq(mcpConnectionApps.connectionId, scope.connectionId)),
          ),
        ]
      : []),
    ...(scope.appRowId ? [eq(apps.id, scope.appRowId)] : []),
  ];
}

const catalogOfApp = and(
  eq(appToolCatalogs.appRowId, apps.id),
  eq(appToolCatalogs.organizationId, apps.organizationId),
);

/**
 * The serving catalogs of every app a caller of the gateway /mcp may use,
 * read in one D1 batch and never from the apps themselves: the active,
 * routable apps of the organization the user has access to, narrowed to a
 * connection's chosen apps or a token's one app. Joins rather than `IN`
 * lists, since D1 binds at most 100 parameters.
 */
async function findVisibleCatalogs(
  scope: VisibilityScope,
): Promise<VisibleCatalog[]> {
  const visible: SQL[] = [
    ...reachableApps(scope),
    eq(appToolCatalogs.status, "ok"),
  ];
  const catalog = catalogOfApp;

  const [appRows, toolRows] = await db.batch([
    db
      .select({
        appRowId: apps.id,
        organizationId: apps.organizationId,
        appSlug: apps.appSlug,
        name: apps.name,
        description: apps.description,
        hostname: apps.hostname,
        workerName: apps.workerName,
        tier: apps.tier,
        versionId: apps.versionId,
        manifest: apps.manifest,
        secretNames: apps.secretNames,
        catalogHash: appToolCatalogs.catalogHash,
        instructions: appToolCatalogs.instructions,
      })
      .from(apps)
      .innerJoin(appToolCatalogs, catalog)
      .where(and(...visible))
      .orderBy(asc(apps.appSlug)),
    db
      .select({
        appRowId: appTools.appRowId,
        name: appTools.name,
        title: appTools.title,
        description: appTools.description,
        risk: appTools.risk,
        inputSchema: appTools.inputSchema,
        outputSchema: appTools.outputSchema,
        annotations: appTools.annotations,
        catalogHash: appTools.catalogHash,
      })
      .from(appTools)
      .innerJoin(apps, eq(apps.id, appTools.appRowId))
      .innerJoin(appToolCatalogs, catalog)
      .where(and(...visible))
      .orderBy(asc(appTools.name)),
  ]);

  return appRows.flatMap((app) =>
    app.catalogHash &&
    (app.tier === PROVIDER_APP_TIER || (app.hostname && app.workerName))
      ? [
          {
            ...app,
            catalogHash: app.catalogHash,
            // As in findByOrgApp: rows from another sync are skipped.
            tools: toolRows
              .filter(
                (row) =>
                  row.appRowId === app.appRowId &&
                  row.catalogHash === app.catalogHash,
              )
              .map(toToolBusTool),
          },
        ]
      : [],
  );
}

/**
 * Replace an app's catalog and tools in one D1 batch, which D1 runs as one
 * transaction: every statement commits, or a failing one rolls the whole
 * sequence back (developers.cloudflare.com/d1/worker-api/d1-database,
 * `batch()`), so a reader never sees half a catalog and a refused write
 * leaves the old snapshot serving (the sync then logs
 * `mcp.catalog.sync_failed`).
 *
 * There is no cap on the tools an app may offer: the ToolBus bounds each
 * tool (a 64-character namespaced name, a 100-character title, a
 * 2,048-character description, 20 KiB per input or output schema) and the
 * whole catalog response (CATALOG_LIMITS.responseBytes, 5 MiB), and one
 * atomic batch holds the largest catalog that passes, against Cloudflare's
 * documented D1 limits (developers.cloudflare.com/d1/platform/limits, read
 * 2026-10-24):
 *
 * - 100 bound parameters per statement: 9 rows × 10 columns = 90
 *   ({@link TOOL_ROWS_PER_INSERT}).
 * - 100 KB of SQL per statement: the values are bound, so an INSERT's text
 *   is the column list and 9 rows of placeholders, under 1 KB.
 * - 2 MB per string, BLOB or row: the largest app_tools row is one tool at
 *   every per-tool limit, about 44 KB; the catalog row's warnings (at most
 *   100 of 500 characters) and instructions (2,048) are far under too.
 * - 30 s for the whole batch call, and no documented cap on the statements
 *   in a batch or on their bound bytes together (the limits page describes
 *   a 2,000-statement batch running as one query). A 5 MiB catalog is at
 *   most 5 MiB of bound values; of the smallest tools that pass (about 75
 *   bytes each) that is some 70,000 tools in some 7,800 INSERTs, which
 *   SQLite writes in one transaction in well under a second.
 *
 * So the catalog response size is the bound, not this write; nothing here
 * counts rows.
 */
async function replace(input: ReplaceCatalogInput): Promise<void> {
  const fetchedAt = new Date();
  const catalog = {
    organizationId: input.organizationId,
    versionId: input.versionId,
    status: input.status,
    catalogHash: input.catalogHash,
    toolCount: input.tools.length,
    instructions: input.instructions,
    sdkVersion: input.sdkVersion,
    warnings: input.warnings.length ? JSON.stringify(input.warnings) : null,
    lastError: input.lastError,
    fetchedAt,
  };
  const rows = input.tools.map((tool) => ({
    appRowId: input.appRowId,
    organizationId: input.organizationId,
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description,
    risk: tool.risk,
    inputSchema: JSON.stringify(tool.inputSchema),
    outputSchema: tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
    annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
    catalogHash: input.catalogHash ?? "",
  }));
  const inserts = [];
  for (let start = 0; start < rows.length; start += TOOL_ROWS_PER_INSERT) {
    inserts.push(
      db
        .insert(appTools)
        .values(rows.slice(start, start + TOOL_ROWS_PER_INSERT)),
    );
  }

  await db.batch([
    db
      .insert(appToolCatalogs)
      .values({ appRowId: input.appRowId, ...catalog })
      .onConflictDoUpdate({ target: appToolCatalogs.appRowId, set: catalog }),
    db.delete(appTools).where(eq(appTools.appRowId, input.appRowId)),
    ...inserts,
  ]);
}

/**
 * Record a failed sync. A catalog that was serving keeps serving: only
 * `last_error` changes, so one bad answer from an app can't take its tools
 * offline (and it stays marked with the version it was taken from, so a
 * newer version is tried again). Without an earlier catalog, the app gets
 * an "error" row. A catalog that isn't serving moves `fetched_at` and
 * `version_id` to this attempt, which is what spaces out the retries on
 * use.
 */
async function recordError(input: {
  appRowId: string;
  organizationId: string;
  versionId: string | null;
  message: string;
}): Promise<void> {
  const attemptedAt = new Date();
  // A serving catalog keeps the column; any other takes this attempt's.
  const unlessServing = (column: Column, attempted: unknown) =>
    sql`CASE WHEN ${appToolCatalogs.status} = 'ok' THEN ${column} ELSE ${attempted} END`;
  await db
    .insert(appToolCatalogs)
    .values({
      appRowId: input.appRowId,
      organizationId: input.organizationId,
      versionId: input.versionId,
      status: "error",
      lastError: input.message,
      fetchedAt: attemptedAt,
    })
    .onConflictDoUpdate({
      target: appToolCatalogs.appRowId,
      set: {
        lastError: input.message,
        fetchedAt: unlessServing(
          appToolCatalogs.fetchedAt,
          attemptedAt.getTime(),
        ),
        versionId: unlessServing(appToolCatalogs.versionId, input.versionId),
      },
    });
}

/** An app whose tools aren't snapshotted, with what its snapshot row says. */
export type UnsyncedApp = {
  rowId: string;
  organizationId: string;
  appSlug: string;
  /** Null for a provider app (tier "provider"). */
  hostname: string | null;
  workerName: string | null;
  tier: string;
  versionId: string | null;
  /** The snapshot row's status, or null without a row. */
  catalogStatus: string | null;
  /**
   * The row's last sync error, null after a sync that stored a snapshot. A
   * serving row keeps serving when a newer version can't be fetched, so
   * this is what says its last sync failed.
   */
  lastError: string | null;
};

/**
 * Apps a caller of the gateway /mcp reaches whose tools aren't snapshotted:
 * never synced, synced from another version than the app runs now, or last
 * tried and failed before `failedBefore`. An app that has no tools, or
 * doesn't serve them, stays as its version's sync recorded it. Each comes
 * with what its snapshot row says, if there is one, so a caller can treat
 * a failed snapshot apart from a missing one.
 */
async function findVisibleUnsyncedApps(
  scope: VisibilityScope,
  {
    failedBefore,
    limit,
    providerCatalogVersion,
  }: {
    failedBefore: Date;
    limit: number;
    /**
     * The gateway's provider catalog version (server/provider-apps): a
     * provider row's snapshot from another is out of date, as an app's
     * from another Worker version is.
     */
    providerCatalogVersion: string;
  },
): Promise<UnsyncedApp[]> {
  const rows = await db
    .select({
      rowId: apps.id,
      organizationId: apps.organizationId,
      appSlug: apps.appSlug,
      hostname: apps.hostname,
      workerName: apps.workerName,
      tier: apps.tier,
      versionId: apps.versionId,
      catalogStatus: appToolCatalogs.status,
      lastError: appToolCatalogs.lastError,
    })
    .from(apps)
    .leftJoin(appToolCatalogs, catalogOfApp)
    .where(
      and(
        ...reachableApps(scope),
        or(
          isNull(appToolCatalogs.appRowId),
          and(
            ne(apps.tier, PROVIDER_APP_TIER),
            isNotNull(apps.versionId),
            or(
              isNull(appToolCatalogs.versionId),
              ne(appToolCatalogs.versionId, apps.versionId),
            ),
          ),
          and(
            eq(apps.tier, PROVIDER_APP_TIER),
            or(
              isNull(appToolCatalogs.versionId),
              ne(appToolCatalogs.versionId, providerCatalogVersion),
            ),
          ),
          and(
            eq(appToolCatalogs.status, "error"),
            lt(appToolCatalogs.fetchedAt, failedBefore),
          ),
        ),
      ),
    )
    .orderBy(asc(apps.appSlug))
    .limit(limit);
  return rows.filter(
    (row) => row.tier === PROVIDER_APP_TIER || (row.hostname && row.workerName),
  );
}

export const AppToolRepository = {
  findByOrgApp,
  findVisibleCatalogs,
  findVisibleUnsyncedApps,
  replace,
  recordError,
} as const;
