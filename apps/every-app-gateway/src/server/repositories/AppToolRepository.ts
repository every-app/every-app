import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import {
  apps,
  appToolCatalogs,
  appTools,
  mcpConnectionApps,
  userAppAccess,
} from "@/db/schema";
import type { ToolBusTool } from "@every-app/toolbus";

type CatalogStatus = "ok" | "empty" | "unsupported" | "error";

export type StoredCatalog = {
  appRowId: string;
  status: CatalogStatus;
  catalogHash: string | null;
  instructions: string | null;
  /** When it was taken; for a catalog that isn't serving, the last try. */
  fetchedAt: Date;
  tools: ToolBusTool[];
};

type ReplaceCatalogInput = {
  appRowId: string;
  organizationId: string;
  status: CatalogStatus;
  catalogHash: string | null;
  instructions: string | null;
  sdkVersion: string | null;
  warnings: string[];
  lastError: string | null;
  tools: ToolBusTool[];
};

// D1 binds at most 100 parameters per statement; app_tools has 10 columns.
const TOOL_ROWS_PER_INSERT = 9;

/** One app the gateway /mcp serves a caller, with its snapshot. */
type VisibleCatalog = {
  appRowId: string;
  appSlug: string;
  name: string;
  description: string;
  hostname: string;
  workerName: string;
  tier: string;
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
  /** A connection that chose its apps. */
  connectionId?: string;
  /** A token bound to one app. */
  appRowId?: string;
};

/** The active apps a caller reaches: org, access, and the scope's choice. */
function reachableApps(scope: VisibilityScope): SQL[] {
  return [
    eq(apps.organizationId, scope.organizationId),
    eq(apps.status, "active"),
    isNotNull(apps.hostname),
    isNotNull(apps.workerName),
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

function accessFor(scope: VisibilityScope) {
  return and(
    eq(userAppAccess.appRowId, apps.id),
    eq(userAppAccess.userId, scope.userId),
    eq(userAppAccess.organizationId, scope.organizationId),
  );
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
  const access = accessFor(scope);
  const catalog = catalogOfApp;

  const [appRows, toolRows] = await db.batch([
    db
      .select({
        appRowId: apps.id,
        appSlug: apps.appSlug,
        name: apps.name,
        description: apps.description,
        hostname: apps.hostname,
        workerName: apps.workerName,
        tier: apps.tier,
        catalogHash: appToolCatalogs.catalogHash,
        instructions: appToolCatalogs.instructions,
      })
      .from(apps)
      .innerJoin(userAppAccess, access)
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
      .innerJoin(userAppAccess, access)
      .innerJoin(appToolCatalogs, catalog)
      .where(and(...visible))
      .orderBy(asc(appTools.name)),
  ]);

  return appRows.flatMap((app) =>
    app.hostname && app.workerName && app.catalogHash
      ? [
          {
            ...app,
            hostname: app.hostname,
            workerName: app.workerName,
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

/** Replace an app's catalog and tools in one D1 transaction. */
async function replace(input: ReplaceCatalogInput): Promise<void> {
  const fetchedAt = new Date();
  const catalog = {
    organizationId: input.organizationId,
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
 * offline. Without an earlier catalog, the app gets an "error" row. A
 * catalog that isn't serving moves `fetched_at` to this attempt, which is
 * what spaces out the retries on first use.
 */
async function recordError(input: {
  appRowId: string;
  organizationId: string;
  message: string;
}): Promise<void> {
  const attemptedAt = new Date();
  await db
    .insert(appToolCatalogs)
    .values({
      appRowId: input.appRowId,
      organizationId: input.organizationId,
      status: "error",
      lastError: input.message,
      fetchedAt: attemptedAt,
    })
    .onConflictDoUpdate({
      target: appToolCatalogs.appRowId,
      set: {
        lastError: input.message,
        fetchedAt: sql`CASE WHEN ${appToolCatalogs.status} = 'ok' THEN ${appToolCatalogs.fetchedAt} ELSE ${attemptedAt.getTime()} END`,
      },
    });
}

/**
 * Apps a caller of the gateway /mcp reaches whose tools aren't snapshotted:
 * never synced, or last tried and failed before `failedBefore`. An app that
 * has no tools, or doesn't serve them, stays as its deploy recorded it.
 */
async function findVisibleUnsyncedApps(
  scope: VisibilityScope,
  { failedBefore, limit }: { failedBefore: Date; limit: number },
): Promise<
  {
    rowId: string;
    organizationId: string;
    appSlug: string;
    hostname: string;
    workerName: string;
    tier: string;
  }[]
> {
  const rows = await db
    .select({
      rowId: apps.id,
      organizationId: apps.organizationId,
      appSlug: apps.appSlug,
      hostname: apps.hostname,
      workerName: apps.workerName,
      tier: apps.tier,
    })
    .from(apps)
    .innerJoin(userAppAccess, accessFor(scope))
    .leftJoin(appToolCatalogs, catalogOfApp)
    .where(
      and(
        ...reachableApps(scope),
        or(
          isNull(appToolCatalogs.appRowId),
          and(
            eq(appToolCatalogs.status, "error"),
            lt(appToolCatalogs.fetchedAt, failedBefore),
          ),
        ),
      ),
    )
    .orderBy(asc(apps.appSlug))
    .limit(limit);
  return rows.flatMap((row) =>
    row.hostname && row.workerName
      ? [{ ...row, hostname: row.hostname, workerName: row.workerName }]
      : [],
  );
}

export const AppToolRepository = {
  findByOrgApp,
  findVisibleCatalogs,
  findVisibleUnsyncedApps,
  replace,
  recordError,
} as const;
