/**
 * The hourly re-list of remote MCP apps (the `scheduled` handler,
 * mcp-auth/maintenance.ts): every active remote app whose snapshot is
 * older than an hour, or missing, is listed again through the catalog
 * sync, so a server whose tools changed reaches connected clients (the
 * ToolBus notices the changed snapshot) without waiting for a call to
 * report drift. At most {@link RELIST_MAX} rows a run, oldest first; one
 * failure doesn't stop the others.
 */
import { logEvent } from "@every-app/perimeter";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { RemoteMcpRepository } from "@/server/repositories/RemoteMcpRepository";
import { logToolSync, syncAppTools } from "@/server/toolbus/catalog-sync";

/** A remote app's snapshot is listed again once it is this old. */
const RELIST_AFTER_MS = 60 * 60_000;
const RELIST_MAX = 50;
/** How long one run spends re-listing before it leaves the rest to the next hour. */
const RELIST_BUDGET_MS = 45_000;

/** Re-list the stale remote apps; how many were tried. */
export async function relistStaleRemoteMcpApps(
  now = new Date(),
): Promise<number> {
  const stale = await RemoteMcpRepository.findStaleRemoteApps(
    new Date(now.getTime() - RELIST_AFTER_MS),
    RELIST_MAX,
  );
  const startedAt = Date.now();
  let tried = 0;
  for (const app of stale) {
    if (Date.now() - startedAt > RELIST_BUDGET_MS) break;
    tried += 1;
    const target = {
      rowId: app.rowId,
      organizationId: app.organizationId,
      appSlug: app.appSlug,
      hostname: null,
      workerName: null,
      tier: PROVIDER_APP_TIER,
      versionId: null,
      manifest: app.manifest,
      name: app.name,
    };
    try {
      logToolSync(target, await syncAppTools(target), "scheduled");
    } catch (error) {
      logEvent(
        "mcp.catalog.sync_failed",
        {
          app: app.appSlug,
          trigger: "scheduled",
          message: error instanceof Error ? error.message : String(error),
        },
        "warn",
      );
    }
  }
  return tried;
}
