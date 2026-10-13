/**
 * After a gateway deploy, snapshot the agent tools of every active app in
 * the deploy token's organization, so apps deployed before this gateway
 * served /mcp (or by an older CLI) are served right away rather than on
 * their first /mcp request. One request per app, never one for all of them:
 * a request may make at most 32 Worker invocations.
 *
 * Best effort: without a deploy token for this gateway it does nothing, and
 * it never fails the gateway deploy. An app it doesn't sync syncs on its
 * next deploy or its first /mcp request.
 */
import { syncAppToolsWithGateway } from "@/commands/app/deploy/steps/syncTools";
import type { D1Database } from "@/lib/cf/d1";
import { readGatewayCredential } from "@/lib/gateway/credentials";
import type { EventSink } from "@/lib/output/events";

/** The new gateway version is already live, so a binding is quick to show. */
const BINDING_RETRY_MS = 20_000;

const STEP = "gateway.tools";

interface ActiveApp {
  appSlug: string;
  hostname: string;
  workerName: string;
}

interface SyncGatewayAppToolsOptions {
  gatewayUrl: string;
  /** The gateway's D1 database, which lists the organization's apps. */
  db: D1Database;
  /**
   * The app Workers the deployed version binds. Others (a Worker deleted by
   * hand, a name the gateway won't bind) can't be reached, so they're left
   * out rather than waited on.
   */
  boundWorkers?: readonly string[];
  out: EventSink;
  verbose: boolean;
  readCredential?: typeof readGatewayCredential;
  syncApp?: typeof syncAppToolsWithGateway;
}

async function listActiveApps(
  db: D1Database,
  organizationId: string,
): Promise<ActiveApp[]> {
  const [rows = []] = await db.run([
    {
      sql: "SELECT app_slug, hostname, worker_name FROM apps WHERE organization_id = ? AND status = 'active' AND hostname IS NOT NULL AND worker_name IS NOT NULL ORDER BY app_slug",
      params: [organizationId],
    },
  ]);
  return rows.flatMap((row) =>
    typeof row["app_slug"] === "string" &&
    typeof row["hostname"] === "string" &&
    typeof row["worker_name"] === "string"
      ? [
          {
            appSlug: row["app_slug"],
            hostname: row["hostname"],
            workerName: row["worker_name"],
          },
        ]
      : [],
  );
}

export async function syncGatewayAppTools(
  options: SyncGatewayAppToolsOptions,
): Promise<void> {
  const { out } = options;
  const syncApp = options.syncApp ?? syncAppToolsWithGateway;
  try {
    const credential = await (options.readCredential ?? readGatewayCredential)(
      options.gatewayUrl,
    );
    if (!credential?.token) {
      if (options.verbose) {
        out.emit({
          type: "progress",
          step: STEP,
          message:
            "No deploy token for this gateway here: each app's agent tools sync on its next deploy or first /mcp request.",
        });
      }
      return;
    }
    const bound = options.boundWorkers && new Set(options.boundWorkers);
    const apps = (
      await listActiveApps(options.db, credential.organizationId)
    ).filter((app) => !bound || bound.has(app.workerName));
    if (apps.length === 0) return;

    out.emit({
      type: "step",
      step: STEP,
      status: "start",
      message: "Syncing agent tools...",
    });
    for (const app of apps) {
      await syncApp({
        gatewayUrl: options.gatewayUrl,
        appId: app.appSlug,
        mcpUrl: `https://${app.hostname}/mcp`,
        out,
        step: STEP,
        verbose: options.verbose,
        retryForMs: BINDING_RETRY_MS,
      });
    }
  } catch (error) {
    out.emit({
      type: "warning",
      code: "TOOLS_NOT_SYNCED",
      step: STEP,
      message: `Agent tools were not synced (${error instanceof Error ? error.message : String(error)}): each app's tools sync on its next deploy or first /mcp request.`,
    });
  }
}
