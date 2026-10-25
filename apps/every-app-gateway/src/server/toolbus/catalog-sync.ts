/**
 * Snapshot an app's agent tools into D1.
 *
 * Runs when an app is activated or deployed through the gateway, when its
 * host sees it run a new version, when the consent page or /mcp finds no
 * snapshot of an app (or one taken from another version than the app runs
 * now), and when a tool call shows the app has a different catalog than
 * the snapshot (self-heal). One sync is exactly one invocation of the app,
 * over its service binding, with a one-minute system token that opens
 * nothing but the catalog. The snapshot records the app version
 * (`apps.version_id`) it was taken from.
 *
 * The consent page and /mcp sync within the request, all missing apps at
 * once, and wait a few seconds for them ({@link syncCatalogsWithin}): what
 * finishes in time is in the answer, the rest finishes after it.
 */
import { env, waitUntil } from "cloudflare:workers";
import {
  AppUnreachableError,
  getAppFetcher,
  logEvent,
  type AppFetcher,
} from "@every-app/perimeter";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import type { CatalogSnapshot } from "@every-app/toolbus";
import {
  providerAppFetcher,
  providerAudience,
  providerBaseUrl,
  providerCatalogVersion,
} from "@/server/provider-apps";
import {
  remoteMcpAppFetcher,
  remoteMcpRouteOf,
  remoteMcpVersion,
} from "@/server/remote-mcp";
import {
  AppToolRepository,
  type CatalogStatus,
  type UnsyncedApp,
} from "@/server/repositories/AppToolRepository";

/** A snapshot that isn't serving is tried again at most this often. */
export const RETRY_FAILED_SYNC_MS = 5 * 60_000;
/**
 * An MCP app's sooner: its listing fails while its credential isn't set,
 * and once `secret set` runs it should serve on the next request or so.
 * A claim per isolate (`claimCatalogSync`) still spaces the attempts.
 */
export const RETRY_FAILED_MCP_SYNC_MS = 30_000;
/** How long a request waits for the snapshots it is missing. */
const INLINE_SYNC_BUDGET_MS = 3_000;
/** At most this many apps are synced within one request; the rest later. */
export const INLINE_SYNCS_MAX = 20;

/**
 * The registry facts a sync needs about an app. A provider app (tier
 * "provider", served in-process) has no hostname and no Worker name.
 */
export type SyncableApp = {
  rowId: string;
  organizationId: string;
  appSlug: string;
  hostname: string | null;
  workerName: string | null;
  tier: string;
  /** The app's `version_id` when the sync started. */
  versionId: string | null;
  /**
   * The stored manifest's JSON: what tells a remote MCP app's row (a
   * `remote` block) from a built-in provider's. Deployed apps need none.
   */
  manifest?: string | null;
  /** The row's name, for a remote app's messages. */
  name?: string;
};

type ToolSyncResult = {
  status: CatalogStatus;
  toolCount: number;
  catalogHash: string | null;
  sdkVersion: string | null;
  warnings: string[];
  error?: string;
};

/** What made the gateway take a snapshot, for the log. */
type SyncTrigger =
  | "drift"
  | "first_use"
  | "new_version"
  | "consent"
  /** The hourly re-list of remote MCP apps, and an operator's refresh. */
  | "scheduled"
  | "refresh";

/**
 * The gateway has no service binding to the app yet: a deploy just updated
 * the bindings and the new gateway version is still rolling out. Retry.
 */
export class BindingNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingNotReadyError";
  }
}

/**
 * Reach an app through the one seam, whatever its tier: its Worker over
 * the service binding or the dispatch namespace, or for a provider app
 * the gateway's own in-process app (server/provider-apps).
 */
export function appFetcherFor(app: SyncableApp): AppFetcher {
  if (app.tier === PROVIDER_APP_TIER) {
    // A remote MCP server's row (its manifest has a `remote` block), or
    // a built-in provider's.
    if (remoteMcpRouteOf(app)) {
      return remoteMcpAppFetcher({
        rowId: app.rowId,
        organizationId: app.organizationId,
        appSlug: app.appSlug,
        ...(app.name ? { name: app.name } : {}),
        manifest: app.manifest ?? null,
      });
    }
    return providerAppFetcher(app);
  }
  if (!app.workerName) {
    throw new AppUnreachableError(
      `App "${app.appSlug}" has no Worker to reach.`,
    );
  }
  return getAppFetcher(env as unknown as Record<string, unknown>, {
    appId: app.appSlug,
    organizationId: app.organizationId,
    workerName: app.workerName,
    tier: app.tier === "dispatch" ? "dispatch" : "service_binding",
  });
}

/** What a snapshot is taken from: the Worker, or the provider app's own origin. */
function catalogTarget(app: SyncableApp): {
  appId: string;
  audience: string;
  baseUrl: string;
} {
  if (app.tier === PROVIDER_APP_TIER) {
    return {
      appId: app.appSlug,
      audience: providerAudience(app.rowId),
      baseUrl: providerBaseUrl(),
    };
  }
  return {
    appId: app.appSlug,
    audience: app.workerName ?? "",
    baseUrl: `https://${app.hostname ?? ""}`,
  };
}

/**
 * The version a snapshot records: the app's Worker version, or for a
 * provider app the gateway's provider catalog version, so a gateway whose
 * provider tools changed re-syncs on first use.
 */
async function snapshotVersion(app: SyncableApp): Promise<string | null> {
  if (app.tier !== PROVIDER_APP_TIER) return app.versionId;
  const remote = remoteMcpRouteOf(app);
  // A remote app's snapshot records its registration's revision, so a
  // changed override or risk default re-lists on first use.
  return remote ? remoteMcpVersion(remote) : providerCatalogVersion();
}

export async function syncAppTools(app: SyncableApp): Promise<ToolSyncResult> {
  let fetcher;
  try {
    fetcher = appFetcherFor(app);
  } catch (error) {
    if (error instanceof AppUnreachableError) {
      throw new BindingNotReadyError(error.message);
    }
    throw error;
  }

  // Loaded on demand: the MCP SDK stays out of control-plane cold starts.
  const { fetchAppCatalog } = await import("@every-app/toolbus");
  const versionId = await snapshotVersion(app);
  let snapshot: CatalogSnapshot;
  try {
    snapshot = await fetchAppCatalog(catalogTarget(app), {
      signing: {
        privateKeyPem: env.JWT_PRIVATE_KEY,
        issuer: env.GATEWAY_URL,
      },
      invoke: (request) => fetcher.fetch(request),
    });
  } catch (error) {
    snapshot = {
      status: "error",
      error: `the app could not be reached (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  if ("error" in snapshot) {
    if (snapshot.status === "unsupported") {
      // The app doesn't speak the contract (any more): nothing to serve.
      await AppToolRepository.replace({
        appRowId: app.rowId,
        organizationId: app.organizationId,
        versionId,
        status: "unsupported",
        catalogHash: null,
        instructions: null,
        sdkVersion: null,
        warnings: [],
        lastError: snapshot.error,
        tools: [],
      });
    } else {
      await AppToolRepository.recordError({
        appRowId: app.rowId,
        organizationId: app.organizationId,
        versionId,
        message: snapshot.error,
      });
    }
    return {
      status: snapshot.status,
      toolCount: 0,
      catalogHash: null,
      sdkVersion: null,
      warnings: [],
      error: snapshot.error,
    };
  }

  // A remote MCP app's list can change under the gateway: say what did.
  const remote = app.tier === PROVIDER_APP_TIER && remoteMcpRouteOf(app);
  const before = remote
    ? await AppToolRepository.findByOrgApp(app.organizationId, app.appSlug)
    : null;
  await AppToolRepository.replace({
    appRowId: app.rowId,
    organizationId: app.organizationId,
    versionId,
    status: snapshot.status,
    catalogHash: snapshot.hash,
    instructions: snapshot.instructions ?? null,
    sdkVersion: snapshot.sdkVersion,
    warnings: snapshot.warnings,
    lastError: null,
    tools: snapshot.tools,
  });
  if (remote && before && before.catalogHash !== snapshot.hash) {
    const was = new Set(before.tools.map((tool) => tool.name));
    const now = new Set(snapshot.tools.map((tool) => tool.name));
    const added = [...now].filter((name) => !was.has(name)).slice(0, 50);
    const removed = [...was].filter((name) => !now.has(name)).slice(0, 50);
    if (added.length > 0 || removed.length > 0) {
      // events: app.tools_changed (kind "remote"): { app, toolCount, previousToolCount, added, removed }
      logEvent("mcp.remote.tools_changed", {
        app: app.appSlug,
        org: app.organizationId,
        tools: snapshot.tools.length,
        previous: before.tools.length,
        added,
        removed,
      });
    }
  }
  return {
    status: snapshot.status,
    toolCount: snapshot.tools.length,
    catalogHash: snapshot.hash,
    sdkVersion: snapshot.sdkVersion,
    warnings: snapshot.warnings,
  };
}

export function logToolSync(
  app: SyncableApp,
  result: ToolSyncResult,
  trigger: SyncTrigger,
): void {
  logEvent(
    "mcp.catalog.sync",
    {
      app: app.appSlug,
      org: app.organizationId,
      trigger,
      status: result.status,
      tools: result.toolCount,
      warnings: result.warnings.length,
      ...(result.error ? { error: result.error } : {}),
    },
    result.status === "error" ? "warn" : "log",
  );
}

// Per isolate: at most one sync per app per window, however many calls
// notice the same drift at once.
const SYNC_WINDOW_MS = 30_000;
const SYNC_CLAIMS_MAX_ENTRIES = 500;
const lastSyncClaim = new Map<string, number>();

/**
 * What a sync claims: the app's row, or the row and version for a sync of
 * a new version, which runs whenever the last sync of the app did.
 */
export function catalogSyncClaim(
  app: SyncableApp,
  trigger: SyncTrigger,
): string {
  return trigger === "new_version"
    ? `${app.rowId}@${app.versionId}`
    : app.rowId;
}

/**
 * Claim the right to sync an app now ({@link catalogSyncClaim}); false
 * while a recent claim holds.
 */
export function claimCatalogSync(key: string, now = Date.now()): boolean {
  const last = lastSyncClaim.get(key);
  if (last !== undefined && now - last < SYNC_WINDOW_MS) return false;
  lastSyncClaim.delete(key);
  lastSyncClaim.set(key, now);
  if (lastSyncClaim.size > SYNC_CLAIMS_MAX_ENTRIES) {
    const oldest = lastSyncClaim.keys().next().value;
    if (oldest !== undefined) lastSyncClaim.delete(oldest);
  }
  return true;
}

export function clearCatalogSyncClaimsForTests(): void {
  lastSyncClaim.clear();
}

/**
 * One sync, logged either way: the snapshot's status, or null when the app
 * couldn't be asked at all (no binding in this isolate yet, say).
 */
async function syncAndLog(
  app: SyncableApp,
  trigger: SyncTrigger,
): Promise<CatalogStatus | null> {
  try {
    const result = await syncAppTools(app);
    logToolSync(app, result, trigger);
    return result.status;
  } catch (error) {
    logEvent(
      "mcp.catalog.sync_failed",
      {
        app: app.appSlug,
        trigger,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return null;
  }
}

/** Re-sync in the background after the response, unless one just ran. */
export function scheduleCatalogResync(
  app: SyncableApp,
  trigger: SyncTrigger = "drift",
): void {
  if (!claimCatalogSync(catalogSyncClaim(app, trigger))) return;
  waitUntil(syncAndLog(app, trigger));
}

/**
 * Sync these apps now, all at once, and wait up to `budgetMs` for them: the
 * statuses of the syncs that finished in time, by app row id. The consent
 * page and /mcp use it ({@link syncUnsyncedCatalogs}) for the apps they
 * find without a snapshot: each needs an answer within a few seconds, so
 * whatever finishes decides what it says, and the rest completes after the
 * response (`waitUntil`) for the next request. An app synced moments ago by
 * another request is skipped.
 */
export async function syncCatalogsWithin(
  apps: SyncableApp[],
  budgetMs: number,
  trigger: SyncTrigger,
): Promise<Map<string, CatalogStatus>> {
  const statuses = new Map<string, CatalogStatus>();
  const unfinished = new Set<Promise<void>>();
  for (const app of apps) {
    if (!claimCatalogSync(catalogSyncClaim(app, trigger))) continue;
    const sync: Promise<void> = syncAndLog(app, trigger).then((status) => {
      if (status) statuses.set(app.rowId, status);
      unfinished.delete(sync);
    });
    unfinished.add(sync);
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(unfinished),
    new Promise((resolve) => {
      deadline = setTimeout(resolve, budgetMs);
    }),
  ]);
  clearTimeout(deadline);
  for (const sync of unfinished) waitUntil(sync);
  return statuses;
}

/**
 * Whether the row's last sync failed: an "error" row, or a serving row
 * whose newer version couldn't be fetched (recordError keeps a serving
 * snapshot and only notes the error on it).
 */
function lastSyncFailed(app: UnsyncedApp): boolean {
  return (
    app.catalogStatus === "error" ||
    (app.catalogStatus === "ok" && app.lastError !== null)
  );
}

/**
 * Sync the apps a request found without a current snapshot, as the consent
 * page and /mcp do: those with none, or one from another version, within
 * the request's budget ({@link syncCatalogsWithin}); those whose last sync
 * failed after the response, so a broken app never slows a request. The
 * statuses of the syncs that finished in time, by app row id.
 */
export async function syncUnsyncedCatalogs(
  apps: UnsyncedApp[],
  trigger: SyncTrigger,
): Promise<Map<string, CatalogStatus>> {
  const missing: UnsyncedApp[] = [];
  for (const app of apps) {
    if (lastSyncFailed(app)) scheduleCatalogResync(app, trigger);
    else missing.push(app);
  }
  if (missing.length === 0) return new Map();
  return syncCatalogsWithin(missing, INLINE_SYNC_BUDGET_MS, trigger);
}
