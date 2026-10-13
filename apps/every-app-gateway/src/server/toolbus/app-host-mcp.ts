/**
 * `https://<app-host>/mcp`, served by the ToolBus from the app's catalog
 * snapshot (the perimeter's `interceptMcp` hook).
 *
 * By the time this runs the perimeter has authenticated the caller (a
 * personal access token, or a same-origin browser session that passed the
 * CSRF check), confirmed access to the app, and ruled out apps that keep
 * their own MCP server (`mcp: "app"`). This finds the snapshot, syncing it
 * on a POST if there is none or a failed one has gone stale, and serves the
 * request. With no snapshot to serve, or when the snapshot can't be read at
 * all (D1 before the catalog migration ran, say), it returns null and the
 * request is proxied to the app as before, so apps that still answer /mcp
 * themselves keep working.
 */
import { env } from "cloudflare:workers";
import {
  getAppFetcher,
  logEvent,
  type McpInterceptInput,
  type RegisteredApp,
} from "@every-app/perimeter";
import type {
  ToolBusApp,
  ToolBusHttpHandler,
  ToolCallAuditEvent,
} from "@every-app/toolbus";
import { AppRepository } from "@/server/repositories/AppRepository";
import {
  AppToolRepository,
  type StoredCatalog,
} from "@/server/repositories/AppToolRepository";
import {
  BindingNotReadyError,
  claimCatalogSync,
  logToolSync,
  scheduleCatalogResync,
  syncAppTools,
  type SyncableApp,
} from "./catalog-sync";

/** Keyed digest context for argument fingerprints (see createArgumentsDigester). */
const ARGS_DIGEST_CONTEXT = "every-app-gateway:mcp-args:v1";
/** A snapshot that isn't serving is retried on use at most this often. */
const RETRY_UNSERVED_SNAPSHOT_MS = 5 * 60_000;

// Registry facts for the apps a request serves, so the per-isolate ToolBus
// can reach them over their bindings and re-sync them on drift.
const servedApps = new WeakMap<ToolBusApp, SyncableApp>();

let toolBus: Promise<ToolBusHttpHandler> | undefined;

function auditLine(event: ToolCallAuditEvent): void {
  // Never the arguments or result: a keyed digest and a size.
  logEvent("mcp.tool_call", {
    surface: event.surface,
    app: event.appId,
    tool: event.tool,
    risk: event.risk,
    decision: event.decision,
    reason: event.reason,
    outcome: event.outcome,
    ms: event.durationMs,
    args_digest: event.argsDigest,
    result_bytes: event.resultBytes,
    proto: event.protocolVersion,
    request_id: event.requestId,
    call_id: event.callId,
    cred_kind: event.credentialKind,
    cred_id: event.credentialId,
    org: event.organizationId,
    user_id: event.userId,
  });
}

function toolBusHttp(): Promise<ToolBusHttpHandler> {
  // The MCP SDK loads with the first /mcp request, not with every isolate.
  toolBus ??= import("@every-app/toolbus").then(
    ({ createArgumentsDigester, createToolBusHttp }) =>
      createToolBusHttp({
        get signing() {
          return {
            privateKeyPem: env.JWT_PRIVATE_KEY,
            issuer: env.GATEWAY_URL,
          };
        },
        invokeApp: (target, request) => {
          const app = servedApps.get(target);
          if (!app) throw new Error(`no route for app "${target.appId}"`);
          return getAppFetcher(env as unknown as Record<string, unknown>, {
            workerName: app.workerName,
            tier: app.tier === "dispatch" ? "dispatch" : "service_binding",
          }).fetch(request);
        },
        onCatalogDrift: (target) => {
          const app = servedApps.get(target);
          if (app) scheduleCatalogResync(app);
        },
        audit: auditLine,
        digestArguments: createArgumentsDigester(
          env.BETTER_AUTH_SECRET,
          ARGS_DIGEST_CONTEXT,
        ),
      }),
  );
  return toolBus;
}

export function resetAppHostMcpForTests(): void {
  toolBus = undefined;
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
  };
}

async function servingCatalog(
  app: RegisteredApp,
): Promise<StoredCatalog | null> {
  const stored = await AppToolRepository.findByOrgApp(
    app.organizationId,
    app.appId,
  );
  return stored?.status === "ok" ? stored : null;
}

// Per isolate: concurrent first requests for an app wait for one sync.
const pendingSyncs = new Map<string, Promise<StoredCatalog | null>>();

/**
 * The snapshot to serve. A POST (a client actually using the tools) syncs
 * inline, one app invocation, when there is none, or the last attempt didn't
 * produce one and is over five minutes old. Other methods never make the
 * gateway call the app: a GET is what a sibling app's page can send with
 * the session cookie. Deploys sync explicitly; this covers apps deployed
 * before the gateway learned to snapshot, or by an older CLI.
 */
async function servableCatalog(
  app: RegisteredApp,
  method: string,
): Promise<StoredCatalog | null> {
  const stored = await AppToolRepository.findByOrgApp(
    app.organizationId,
    app.appId,
  );
  if (stored?.status === "ok") return stored;
  if (method !== "POST") return null;
  if (
    stored &&
    Date.now() - stored.fetchedAt.getTime() < RETRY_UNSERVED_SNAPSHOT_MS
  ) {
    return null;
  }

  const key = `${app.organizationId}\u0000${app.appId}`;
  let pending = pendingSyncs.get(key);
  if (!pending) {
    pending = syncOnFirstUse(app).finally(() => pendingSyncs.delete(key));
    pendingSyncs.set(key, pending);
  }
  return pending;
}

async function syncOnFirstUse(
  app: RegisteredApp,
): Promise<StoredCatalog | null> {
  const target = await syncableApp(app);
  if (!target) return null;
  // Synced moments ago (by a request that read the catalog before this one
  // did): serve what that sync stored.
  if (!claimCatalogSync(target.rowId)) return servingCatalog(app);
  try {
    logToolSync(target, await syncAppTools(target), "first_use");
  } catch (error) {
    if (error instanceof BindingNotReadyError) return null;
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

  const toolBusApp: ToolBusApp = {
    rowId: catalog.appRowId,
    appId: app.appId,
    name: app.manifest.name ?? app.appId,
    baseUrl: `https://${app.hostname}`,
    catalogHash: catalog.catalogHash,
    ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
    tools: catalog.tools,
  };
  servedApps.set(toolBusApp, {
    rowId: catalog.appRowId,
    organizationId: app.organizationId,
    appSlug: app.appId,
    hostname: app.hostname,
    workerName: app.workerName,
    tier: app.tier,
  });

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
