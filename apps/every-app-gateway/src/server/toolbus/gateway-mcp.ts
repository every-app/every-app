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
 * /mcp keeps nothing between requests, so the tools are fetched before the
 * answer, never after it. The snapshots are normally taken when an app is
 * activated or deployed; an app a client uses (a POST) that has none yet,
 * or one from another version than the app runs, is synced within the
 * request, up to a few seconds, and what finished is in the answer. One
 * whose last sync failed is retried in the background after five minutes,
 * so a broken app never slows a request. A connected client still learns
 * of a changed list (an app added, removed or redeployed): the ToolBus
 * compares each 2025-era request's session with the list, and holds a
 * 2026-07-28 `subscriptions/listen` stream that re-reads the catalogs
 * through the view's `refresh` (see packages/toolbus/src/http.ts).
 */
import { env } from "cloudflare:workers";
import { extractBearerCredential, logEvent } from "@every-app/perimeter";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "@every-app/sdk/internal";
import type { McpPrincipal, ToolBusView } from "@every-app/toolbus";
import { platformPolicy } from "@/server/platform-policy";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import {
  resolveOauthCaller,
  resolvePatCaller,
  type McpCaller,
} from "@/server/mcp-auth/validate";
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

  let view: ToolBusView;
  try {
    view = await gatewayView(
      request.headers.get("cf-ray") ?? undefined,
      principal,
      scope,
      recheckFor(request, caller),
    );
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

  const serve = await toolBusHttp();
  return serve(request, view);
}

/**
 * Whether the caller still stands, for a held stream's polls: a revoked
 * connection, a removed or deactivated member, a suspended organization or
 * a revoked token takes effect on the next request, and a poll is one.
 * Throws when it doesn't, which ends the stream. A poll is no use of the
 * credential, so it leaves last-used alone.
 */
function recheckFor(request: Request, caller: McpCaller): () => Promise<void> {
  if (caller.kind !== "caller") return async () => undefined;
  const { principal } = caller;
  const refused = () => {
    throw new Error("the caller no longer stands");
  };
  if (principal.credential.kind === "oauth") {
    const props = {
      v: 1,
      kind: "oauth",
      connectionId: principal.credential.id,
      userId: principal.userId,
      organizationId: principal.organizationId,
    };
    const scope =
      principal.access === "write"
        ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE]
        : [MCP_READ_SCOPE];
    return async () => {
      const again = await resolveOauthCaller(props, scope, { touch: false });
      if (!again || again === "insufficient_scope" || again.kind !== "caller") {
        refused();
      }
    };
  }
  const token = extractBearerCredential(request.headers);
  if (token?.startsWith("epat_")) {
    return async () => {
      const again = await resolvePatCaller(token, { touch: false });
      if (!again || again.kind !== "caller") refused();
    };
  }
  return async () => undefined;
}

/**
 * The caller's view of the catalogs as they are now. A held
 * `subscriptions/listen` stream re-reads it through `refresh` (after the
 * caller is rechecked), so an app that appears, goes or is redeployed
 * reaches the connected client, and a caller that lost access stops
 * hearing about them. Captures no Request: a stream lives ten minutes.
 */
async function gatewayView(
  requestId: string | undefined,
  principal: McpPrincipal,
  scope: Parameters<typeof AppToolRepository.findVisibleCatalogs>[0],
  recheck: () => Promise<void>,
): Promise<ToolBusView> {
  const catalogs = await AppToolRepository.findVisibleCatalogs(scope);
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

  const { gatewaySurfaceView } = await import("@every-app/toolbus");
  return {
    ...gatewaySurfaceView(principal, apps, {
      ...(requestId ? { requestId } : {}),
      allowedOrigins: allowedOrigins(),
    }),
    refresh: async () => {
      await recheck();
      return gatewayView(requestId, principal, scope, recheck);
    },
  };
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
