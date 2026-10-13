/**
 * After a deploy, ask the gateway to snapshot the app's agent tools (its
 * `defineTools()` catalog). The gateway serves MCP clients from that
 * snapshot at `https://<app-host>/mcp`, so it must be taken after the new
 * app version is live and the gateway's service bindings include it.
 *
 * The binding update just before this may still be rolling out, so the
 * gateway's "binding not ready" answer is retried for up to a minute. This
 * step never fails a deploy, whatever goes wrong (the app is already live,
 * and the gateway also syncs on first use of /mcp): it says what happened,
 * as a warning when the tools weren't synced, and returns null.
 */
import {
  GatewayApiError,
  GatewayClient,
  isOutdatedGatewayError,
  type SyncAppToolsResponse,
} from "@/lib/gateway/api";
import type { EventSink } from "@/lib/output/events";

const RETRY_FOR_MS = 60_000;
const MAX_RETRY_DELAY_MS = 8_000;

interface SyncAppToolsOptions {
  gatewayUrl: string;
  appId: string;
  /** Reported when tools are synced, e.g. `https://todo.apps.example.com/mcp`. */
  mcpUrl: string;
  out: EventSink;
  /** The step its events belong to. Default `app.tools`. */
  step?: string;
  verbose?: boolean;
  /** How long a binding that isn't ready yet is waited for. Default 60 s. */
  retryForMs?: number;
  client?: Pick<GatewayClient, "syncAppTools">;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function isBindingNotReady(error: unknown): boolean {
  return (
    error instanceof GatewayApiError &&
    error.status === 503 &&
    error.code === "BINDING_NOT_READY"
  );
}

function isRouteMissing(error: unknown): boolean {
  return (
    isOutdatedGatewayError(error) ||
    (error instanceof GatewayApiError && error.status === 404 && !error.code)
  );
}

export async function syncAppToolsWithGateway(
  options: SyncAppToolsOptions,
): Promise<SyncAppToolsResponse | null> {
  try {
    return await syncAndReport(options);
  } catch (error) {
    notSynced(
      options,
      `Agent tools for ${options.appId} were not synced: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

const SYNC_STATUSES = new Set(["ok", "empty", "unsupported", "error"]);

function notSynced(
  options: SyncAppToolsOptions,
  message: string,
  code = "TOOLS_NOT_SYNCED",
): void {
  options.out.emit({
    type: "warning",
    code,
    step: options.step ?? "app.tools",
    message,
    data: { appId: options.appId },
  });
}

async function syncAndReport(
  options: SyncAppToolsOptions,
): Promise<SyncAppToolsResponse | null> {
  const { appId, out } = options;
  const step = options.step ?? "app.tools";
  const client =
    options.client ?? new GatewayClient({ gatewayUrl: options.gatewayUrl });
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const giveUpAt = now() + (options.retryForMs ?? RETRY_FOR_MS);

  let result: SyncAppToolsResponse;
  for (let delay = 1_000; ; delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS)) {
    try {
      result = await client.syncAppTools(appId);
      break;
    } catch (error) {
      if (isBindingNotReady(error) && now() + delay < giveUpAt) {
        if (options.verbose) {
          out.emit({
            type: "progress",
            step,
            message: `Waiting for the gateway to reach ${appId}...`,
          });
        }
        await sleep(delay);
        continue;
      }
      if (isBindingNotReady(error)) {
        notSynced(
          options,
          `Agent tools for ${appId}: the gateway can't reach the app yet; they will sync the first time /mcp is used.`,
          "TOOLS_SYNC_DEFERRED",
        );
      } else if (isRouteMissing(error)) {
        notSynced(
          options,
          `Agent tools for ${appId}: this gateway doesn't serve them yet. Run: npx everyapp gateway upgrade`,
          "GATEWAY_OUTDATED",
        );
      } else {
        notSynced(
          options,
          `Agent tools for ${appId} were not synced: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }

  if (!SYNC_STATUSES.has(result?.status)) {
    notSynced(
      options,
      `Agent tools for ${appId}: the gateway's answer to the sync wasn't understood; they will sync the first time /mcp is used.`,
    );
    return null;
  }
  if (result.status === "ok") {
    out.emit({
      type: "step",
      step,
      status: "ok",
      message: `Agent tools for ${appId}: ${result.toolCount} synced. MCP: ${options.mcpUrl}`,
      data: { appId, toolCount: result.toolCount, mcpUrl: options.mcpUrl },
    });
  } else if (result.status === "error") {
    notSynced(
      options,
      `Agent tools for ${appId} were not synced: ${result.error ?? "the app's catalog could not be read"}`,
    );
  } else if (options.verbose) {
    out.emit({
      type: "progress",
      step,
      message:
        result.status === "empty"
          ? `${appId} defines no agent tools (defineTools).`
          : `${appId} doesn't serve agent tools (needs @every-app/sdk 0.3 or later).`,
    });
  }
  for (const warning of result.warnings ?? []) {
    out.emit({
      type: "warning",
      code: "TOOL_SKIPPED",
      step,
      message: `${appId}: ${warning}`,
      data: { appId },
    });
  }
  return result;
}
