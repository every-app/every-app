/**
 * The gateway's own `${GATEWAY_URL}/mcp`: one MCP server for every app a
 * caller may use, under `<appId>_<tool>` names, plus the built-in
 * `everyapp_*` tools.
 *
 * The caller is already resolved (mcp-auth/validate.ts): an OAuth connection
 * or a personal access token. This serves, from the catalogs in D1, the
 * apps the caller reaches: active apps of their organization they have
 * access to and, on the hosted gateway, the shared apps, narrowed to the
 * connection's chosen apps or the token's app. `tools/call` reaches
 * exactly one app over its service binding, with an identity minted for
 * that call.
 *
 * /mcp is stateless: each request stands alone, with no session, no
 * stream and no notification to push a changed tool list later. So the
 * tools are fetched before the answer, never after it. The snapshots are
 * normally taken when an app is activated or deployed; an app a client
 * uses (a POST) that has none yet, or one from another version than the
 * app runs, is synced within the request, up to a few seconds, and what
 * finished is in the answer. One whose last sync failed is retried in the
 * background after five minutes, so a broken app never slows a request.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { platformPolicy } from "@/server/platform-policy";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import type { McpCaller } from "@/server/mcp-auth/validate";
import {
  INLINE_SYNCS_MAX,
  RETRY_FAILED_SYNC_MS,
  syncUnsyncedCatalogs,
} from "./catalog-sync";
import { servedApp, toolBusHttp } from "./runtime";

/**
 * Browser origins allowed to call the gateway's /mcp besides its own:
 * MCP_ALLOWED_ORIGINS, comma or space separated (e.g. MCP Inspector's
 * `http://localhost:6274`). Empty by default; AI apps call from servers.
 */
function allowedOrigins(): string[] {
  return (env.MCP_ALLOWED_ORIGINS ?? "").split(/[\s,]+/).flatMap((value) => {
    if (!value) return [];
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? [url.origin.toLowerCase()]
        : [];
    } catch {
      return [];
    }
  });
}

export async function serveGatewayMcp(
  request: Request,
  caller: McpCaller,
): Promise<Response> {
  if (caller.kind === "refused") {
    return Response.json(
      { error: "forbidden", reason: caller.reason },
      { status: 403 },
    );
  }
  const { principal } = caller;
  const scope = {
    organizationId: principal.organizationId,
    userId: principal.userId,
    sharedApps: platformPolicy(env).sharedApps,
    ...caller.apps,
  };

  if (request.method === "POST") {
    await syncUnsyncedApps(scope);
  }

  let catalogs;
  try {
    catalogs = await AppToolRepository.findVisibleCatalogs(scope);
  } catch (error) {
    logEvent(
      "mcp.catalog.unavailable",
      {
        surface: "gateway",
        org: principal.organizationId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "The tool catalog is unavailable." },
        id: null,
      },
      { status: 503 },
    );
  }

  const apps = catalogs.map((catalog) =>
    servedApp(
      {
        rowId: catalog.appRowId,
        appId: catalog.appSlug,
        audience: catalog.workerName,
        name: catalog.name,
        ...(catalog.description ? { description: catalog.description } : {}),
        baseUrl: `https://${catalog.hostname}`,
        catalogHash: catalog.catalogHash,
        ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
        tools: catalog.tools,
      },
      {
        // The app row's own organization, where its catalog is kept; the
        // call's identity carries the caller's (principal).
        rowId: catalog.appRowId,
        organizationId: catalog.organizationId,
        appSlug: catalog.appSlug,
        hostname: catalog.hostname,
        workerName: catalog.workerName,
        tier: catalog.tier,
        versionId: catalog.versionId,
      },
    ),
  );

  const [{ gatewaySurfaceView }, serve] = await Promise.all([
    import("@every-app/toolbus"),
    toolBusHttp(),
  ]);
  return serve(
    request,
    gatewaySurfaceView(principal, apps, {
      requestId: request.headers.get("cf-ray") ?? undefined,
      allowedOrigins: allowedOrigins(),
    }),
  );
}

/**
 * Sync the reachable apps whose tools aren't snapshotted, before the
 * catalogs are read: those with no snapshot, or one from another version,
 * within the request's budget; those whose last sync failed in the
 * background. Never fails the request: a sync it misses happens on a later
 * one.
 */
async function syncUnsyncedApps(
  scope: Parameters<typeof AppToolRepository.findVisibleUnsyncedApps>[0],
): Promise<void> {
  try {
    const unsynced = await AppToolRepository.findVisibleUnsyncedApps(scope, {
      failedBefore: new Date(Date.now() - RETRY_FAILED_SYNC_MS),
      limit: INLINE_SYNCS_MAX,
    });
    await syncUnsyncedCatalogs(unsynced, "first_use");
  } catch (error) {
    logEvent(
      "mcp.catalog.unavailable",
      {
        surface: "gateway",
        org: scope.organizationId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
  }
}
