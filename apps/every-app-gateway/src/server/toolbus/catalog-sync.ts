/**
 * Snapshot an app's agent tools into D1.
 *
 * Runs when `everyapp app deploy` calls the deploy API, when a tool call
 * shows the app has a different catalog than the snapshot (self-heal), and
 * when an app host's /mcp finds no usable snapshot. One sync is exactly one
 * invocation of the app, over its service binding, with a one-minute system
 * token that opens nothing but the catalog.
 */
import { env, waitUntil } from "cloudflare:workers";
import {
  AppUnreachableError,
  getAppFetcher,
  logEvent,
} from "@every-app/perimeter";
import type { CatalogSnapshot } from "@every-app/toolbus";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";

/** The registry facts a sync needs about an app. */
export type SyncableApp = {
  rowId: string;
  organizationId: string;
  appSlug: string;
  hostname: string;
  workerName: string;
  tier: string;
};

type ToolSyncResult = {
  status: "ok" | "empty" | "unsupported" | "error";
  toolCount: number;
  catalogHash: string | null;
  sdkVersion: string | null;
  warnings: string[];
  error?: string;
};

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

export async function syncAppTools(app: SyncableApp): Promise<ToolSyncResult> {
  let fetcher;
  try {
    fetcher = getAppFetcher(env as unknown as Record<string, unknown>, {
      workerName: app.workerName,
      tier: app.tier === "dispatch" ? "dispatch" : "service_binding",
    });
  } catch (error) {
    if (error instanceof AppUnreachableError) {
      throw new BindingNotReadyError(error.message);
    }
    throw error;
  }

  // Loaded on demand: the MCP SDK stays out of control-plane cold starts.
  const { fetchAppCatalog } = await import("@every-app/toolbus");
  let snapshot: CatalogSnapshot;
  try {
    snapshot = await fetchAppCatalog(
      { appId: app.appSlug, baseUrl: `https://${app.hostname}` },
      {
        signing: {
          privateKeyPem: env.JWT_PRIVATE_KEY,
          issuer: env.GATEWAY_URL,
        },
        invoke: (request) => fetcher.fetch(request),
      },
    );
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

  await AppToolRepository.replace({
    appRowId: app.rowId,
    organizationId: app.organizationId,
    status: snapshot.status,
    catalogHash: snapshot.hash,
    instructions: snapshot.instructions ?? null,
    sdkVersion: snapshot.sdkVersion,
    warnings: snapshot.warnings,
    lastError: null,
    tools: snapshot.tools,
  });
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
  trigger: "deploy" | "drift" | "first_use",
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

/** Claim the right to sync an app now; false while a recent claim holds. */
export function claimCatalogSync(appRowId: string, now = Date.now()): boolean {
  const last = lastSyncClaim.get(appRowId);
  if (last !== undefined && now - last < SYNC_WINDOW_MS) return false;
  lastSyncClaim.delete(appRowId);
  lastSyncClaim.set(appRowId, now);
  if (lastSyncClaim.size > SYNC_CLAIMS_MAX_ENTRIES) {
    const oldest = lastSyncClaim.keys().next().value;
    if (oldest !== undefined) lastSyncClaim.delete(oldest);
  }
  return true;
}

export function clearCatalogSyncClaimsForTests(): void {
  lastSyncClaim.clear();
}

/** Re-sync in the background after the response, unless one just ran. */
export function scheduleCatalogResync(app: SyncableApp): void {
  if (!claimCatalogSync(app.rowId)) return;
  waitUntil(
    syncAppTools(app)
      .then((result) => logToolSync(app, result, "drift"))
      .catch((error: unknown) =>
        logEvent(
          "mcp.catalog.sync_failed",
          {
            app: app.appSlug,
            trigger: "drift",
            message: error instanceof Error ? error.message : String(error),
          },
          "warn",
        ),
      ),
  );
}
