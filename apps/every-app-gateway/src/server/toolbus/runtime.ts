/**
 * The gateway's one ToolBus, shared by both MCP surfaces: an app host's
 * `/mcp` and the gateway's own. It is built once per isolate, with the MCP
 * SDK loaded on the first `/mcp` request rather than with every isolate.
 *
 * Each request registers the apps it serves (`servedApp`), so the ToolBus can
 * reach them over their service bindings and re-sync a catalog that drifted.
 * Every tool call leaves one `mcp.tool_call` log line and one
 * `mcp_tool_calls` row, written after the response; neither ever holds the
 * arguments or the result.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import type {
  ToolBusApp,
  ToolBusHttpHandler,
  ToolCallAuditEvent,
} from "@every-app/toolbus";
import { McpToolCallRepository } from "@/server/repositories/McpToolCallRepository";
import {
  appFetcherFor,
  scheduleCatalogResync,
  type SyncableApp,
} from "./catalog-sync";

/** Keyed digest context for argument fingerprints (see createArgumentsDigester). */
const ARGS_DIGEST_CONTEXT = "every-app-gateway:mcp-args:v1";

// Registry facts for the apps a request serves, keyed by the view's object.
const servedApps = new WeakMap<ToolBusApp, SyncableApp>();

let toolBus: Promise<ToolBusHttpHandler> | undefined;

/** Tests shorten a held subscriptions/listen stream's poll and life. */
export const listenIntervalsForTests: { pollMs?: number; maxMs?: number } = {};

/** Register an app a request serves, and return it for the request's view. */
export function servedApp(app: ToolBusApp, route: SyncableApp): ToolBusApp {
  servedApps.set(app, route);
  return app;
}

function auditToolCall(event: ToolCallAuditEvent): void {
  // Never the arguments or result: a keyed digest and a size. Nor an
  // email: an Access credential's id is the person's address, which the
  // audit row keeps; the log line has the user id.
  const credentialId =
    event.credentialKind === "access" ? undefined : event.credentialId;
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
    cred_id: credentialId,
    client: event.clientInfo,
    org: event.organizationId,
    user_id: event.userId,
  });
  waitUntil(
    McpToolCallRepository.insert(event).catch((error: unknown) =>
      logEvent(
        "mcp.tool_call.audit_failed",
        {
          call_id: event.callId,
          message: error instanceof Error ? error.message : String(error),
        },
        "warn",
      ),
    ),
  );
}

export function toolBusHttp(): Promise<ToolBusHttpHandler> {
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
          return appFetcherFor(app).fetch(request);
        },
        onCatalogDrift: (target) => {
          const app = servedApps.get(target);
          if (app) scheduleCatalogResync(app);
        },
        audit: auditToolCall,
        digestArguments: createArgumentsDigester(
          env.BETTER_AUTH_SECRET,
          ARGS_DIGEST_CONTEXT,
        ),
        ...(listenIntervalsForTests.pollMs
          ? { listenPollMs: listenIntervalsForTests.pollMs }
          : {}),
        ...(listenIntervalsForTests.maxMs
          ? { listenMaxMs: listenIntervalsForTests.maxMs }
          : {}),
      }),
  );
  return toolBus;
}

export function resetToolBusForTests(): void {
  toolBus = undefined;
}
