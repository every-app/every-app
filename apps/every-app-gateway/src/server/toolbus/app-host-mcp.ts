/**
 * `https://<app-host>/mcp`, served by the ToolBus from the app's catalog
 * snapshot (the perimeter's `interceptMcp` hook).
 *
 * By the time this runs the perimeter has authenticated the caller (a
 * personal access token, or a same-origin browser session that passed the
 * CSRF check), confirmed access to the app, and ruled out apps that keep
 * their own MCP server (`mcp: "app"`). This finds the snapshot, syncing it
 * on a POST if there is none, it was taken from another version than the
 * app runs now, or a failed one has gone stale, and serves the request.
 * With no snapshot to serve, or when the snapshot can't be read at all (D1
 * before the catalog migration ran, say), it returns null and the request
 * is proxied to the app as before, so apps that still answer /mcp
 * themselves keep working.
 */
import {
  logEvent,
  type McpInterceptInput,
  type RegisteredApp,
} from "@every-app/perimeter";
import { AppRepository } from "@/server/repositories/AppRepository";
import {
  AppToolRepository,
  type StoredCatalog,
} from "@/server/repositories/AppToolRepository";
import {
  BindingNotReadyError,
  claimCatalogSync,
  logToolSync,
  syncAppTools,
  type SyncableApp,
} from "./catalog-sync";
import { resetToolBusForTests, servedApp, toolBusHttp } from "./runtime";

/** A snapshot that isn't serving is retried on use at most this often. */
const RETRY_UNSERVED_SNAPSHOT_MS = 5 * 60_000;

export function resetAppHostMcpForTests(): void {
  resetToolBusForTests();
  pendingSyncs.clear();
}

async function syncableApp(app: RegisteredApp): Promise<SyncableApp | null> {
  const row = await AppRepository.findByAppSlug(app.appId, app.organizationId);
  if (!row || !row.hostname || !row.workerName) return null;
  return {
    rowId: row.id,
    organizationId: row.organizationId,
    appSlug: row.appSlug,
    hostname: row.hostname,
    workerName: row.workerName,
    tier: row.tier,
    versionId: row.versionId,
  };
}

function serving(stored: StoredCatalog | null): StoredCatalog | null {
  return stored?.status === "ok" ? stored : null;
}

async function servingCatalog(
  app: RegisteredApp,
): Promise<StoredCatalog | null> {
  return serving(
    await AppToolRepository.findByOrgApp(app.organizationId, app.appId),
  );
}

/** Taken from another version than the app runs now: a redeploy since. */
function fromOtherVersion(stored: StoredCatalog): boolean {
  return (
    stored.appVersionId !== null && stored.versionId !== stored.appVersionId
  );
}

// Per isolate: concurrent first requests for an app wait for one sync.
const pendingSyncs = new Map<string, Promise<StoredCatalog | null>>();

/**
 * The snapshot to serve. A POST (a client actually using the tools) syncs
 * inline, one app invocation, when there is none, when it was taken from
 * another version than the app runs now (a redeploy), or when the last
 * attempt didn't produce one and is over five minutes old. Until a sync
 * stores a new one, a serving snapshot from the older version is served.
 * Other methods never make the gateway call the app: a GET is what a
 * sibling app's page can send with the session cookie.
 */
async function servableCatalog(
  app: RegisteredApp,
  method: string,
): Promise<StoredCatalog | null> {
  const stored = await AppToolRepository.findByOrgApp(
    app.organizationId,
    app.appId,
  );
  const current = stored !== null && !fromOtherVersion(stored);
  if (current && stored.status === "ok") return stored;
  if (method !== "POST") return serving(stored);
  if (
    current &&
    Date.now() - stored.fetchedAt.getTime() < RETRY_UNSERVED_SNAPSHOT_MS
  ) {
    return null;
  }

  const key = `${app.organizationId}\u0000${app.appId}`;
  let pending = pendingSyncs.get(key);
  if (!pending) {
    pending = syncOnUse(app, stored).finally(() => pendingSyncs.delete(key));
    pendingSyncs.set(key, pending);
  }
  return pending;
}

async function syncOnUse(
  app: RegisteredApp,
  stored: StoredCatalog | null,
): Promise<StoredCatalog | null> {
  const target = await syncableApp(app);
  if (!target) return serving(stored);
  // A new version gets its own sync at once, whenever the last one ran.
  const newVersion = stored !== null && fromOtherVersion(stored);
  const claim = newVersion
    ? `${target.rowId}@${target.versionId}`
    : target.rowId;
  // Synced moments ago (by a request that read the catalog before this one
  // did): serve what that sync stored.
  if (!claimCatalogSync(claim)) return servingCatalog(app);
  try {
    logToolSync(
      target,
      await syncAppTools(target),
      newVersion ? "new_version" : "first_use",
    );
  } catch (error) {
    // This isolate can't reach the app yet: keep serving what there is.
    if (error instanceof BindingNotReadyError) return serving(stored);
    throw error;
  }
  return servingCatalog(app);
}

export async function serveAppHostMcp({
  request,
  app,
  session,
}: McpInterceptInput): Promise<Response | null> {
  let catalog: StoredCatalog | null;
  try {
    catalog = await servableCatalog(app, request.method);
  } catch (error) {
    // Without a readable snapshot the app answers /mcp as it did before
    // the gateway served it, rather than every request failing with 502.
    logEvent(
      "mcp.catalog.unavailable",
      {
        app: app.appId,
        org: app.organizationId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return null;
  }
  if (!catalog?.catalogHash) return null;

  const { appSurfaceView, principalFromSession } = await import(
    "@every-app/toolbus"
  );
  const principal = principalFromSession(session, { sessionKind: "session" });
  if (!principal.ok) {
    // Only personal tokens and browser sessions reach app-host /mcp.
    if (principal.reason === "unsupported_credential") return null;
    return Response.json(
      { error: "forbidden", reason: "token_scope" },
      { status: 403 },
    );
  }

  const toolBusApp = servedApp(
    {
      rowId: catalog.appRowId,
      appId: app.appId,
      name: app.manifest.name ?? app.appId,
      baseUrl: `https://${app.hostname}`,
      catalogHash: catalog.catalogHash,
      ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
      tools: catalog.tools,
    },
    {
      rowId: catalog.appRowId,
      organizationId: app.organizationId,
      appSlug: app.appId,
      hostname: app.hostname,
      workerName: app.workerName,
      tier: app.tier,
      versionId: catalog.appVersionId,
    },
  );

  const serve = await toolBusHttp();
  return serve(
    request,
    appSurfaceView(
      toolBusApp,
      principal.principal,
      request.headers.get("cf-ray") ?? undefined,
    ),
  );
}
