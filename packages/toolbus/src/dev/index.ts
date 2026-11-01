/**
 * A local ToolBus for `everyapp dev`. It serves `<app>.localhost/mcp` from
 * the app's live catalog (refetched every couple of seconds, so edits to
 * `defineTools()` show up on the next request) with the same policy,
 * argument validation and identity contract as the gateway. MCP Inspector,
 * Claude Code and scripted JSON-RPC all work against the dev server.
 *
 * Dev only: tokens are minted with the dev kid, which apps trust only under
 * EVERYAPP_DEV, and only localhost-class hosts and origins are served. Their
 * audience is the app id, which a dev Worker (no EVERYAPP_AUDIENCE) expects
 * under EVERYAPP_DEV.
 */
import { IDENTITY_DEV_KEY_ID } from "@every-app/sdk/internal";
import { fetchAppCatalog, type CatalogSnapshot } from "../catalog";
import { createToolBusHttp } from "../http";
import { principalFromSession, type SessionLike } from "../principal";
import type { ToolBusApp, ToolCallAuditEvent } from "../types";
import { appSurfaceView } from "../view";

export type { ToolCallAuditEvent } from "../types";

export interface DevToolBusApp {
  appId: string;
  name?: string;
  /** Where the app is reached locally, e.g. `http://todo.localhost:8787`. */
  baseUrl: string;
  /** Reaches the app's dev server. */
  fetcher: { fetch(request: Request): Promise<Response> };
}

export interface DevToolBusOptions {
  apps: DevToolBusApp[];
  privateKeyPem: string;
  issuer: string;
  /** Defaults to the dev kid, which apps trust only under EVERYAPP_DEV. */
  keyId?: string;
  onToolCall?(event: ToolCallAuditEvent): void;
  /** An app's catalog can't be served; each distinct problem is told once. */
  onCatalogProblem?(appId: string, problem: string): void;
  catalogTtlMs?: number;
}

export interface DevToolBus {
  /**
   * Serve an app-host /mcp request, or return null (body unread) when the
   * app has no tools, so the app answers /mcp itself.
   */
  serveAppHost(
    request: Request,
    appId: string,
    session: SessionLike,
  ): Promise<Response | null>;
}

const DEFAULT_CATALOG_TTL_MS = 2_000;

export function createDevToolBus(options: DevToolBusOptions): DevToolBus {
  const apps = new Map(options.apps.map((app) => [app.appId, app]));
  const signing = {
    privateKeyPem: options.privateKeyPem,
    issuer: options.issuer,
    keyId: options.keyId ?? IDENTITY_DEV_KEY_ID,
  };
  const ttlMs = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  const catalogs = new Map<
    string,
    { expiresAt: number; snapshot: Promise<CatalogSnapshot> }
  >();
  const told = new Set<string>();

  const tell = (appId: string, problem: string) => {
    const key = `${appId}\u0000${problem}`;
    if (told.has(key)) return;
    told.add(key);
    options.onCatalogProblem?.(appId, problem);
  };

  const catalogFor = (app: DevToolBusApp): Promise<CatalogSnapshot> => {
    const cached = catalogs.get(app.appId);
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
    const snapshot = fetchAppCatalog(
      { ...app, audience: app.appId },
      {
        signing,
        invoke: (request) => app.fetcher.fetch(request),
      },
    ).catch((error: unknown): CatalogSnapshot => ({
      status: "error",
      error: `could not reach the app (${error instanceof Error ? error.message : String(error)})`,
    }));
    catalogs.set(app.appId, { expiresAt: Date.now() + ttlMs, snapshot });
    return snapshot;
  };

  const http = createToolBusHttp({
    signing,
    invokeApp: (app, request) => {
      const target = apps.get(app.appId);
      if (!target) throw new Error(`no dev app "${app.appId}"`);
      return target.fetcher.fetch(request);
    },
    onCatalogDrift: (app) => catalogs.delete(app.appId),
    audit: options.onToolCall,
    localhostOnly: true,
  });

  return {
    async serveAppHost(request, appId, session) {
      const app = apps.get(appId);
      if (!app) return null;
      const snapshot = await catalogFor(app);
      if ("error" in snapshot) {
        tell(appId, snapshot.error);
        return null;
      }
      if (snapshot.status === "empty") return null;
      for (const warning of snapshot.warnings) tell(appId, warning);

      const principal = principalFromSession(session, { sessionKind: "dev" });
      if (!principal.ok) {
        return Response.json(
          { error: "forbidden", reason: principal.reason },
          { status: 403 },
        );
      }
      const toolBusApp: ToolBusApp = {
        rowId: appId,
        appId,
        audience: appId,
        name: app.name ?? appId,
        baseUrl: app.baseUrl,
        catalogHash: snapshot.hash,
        ...(snapshot.instructions
          ? { instructions: snapshot.instructions }
          : {}),
        tools: snapshot.tools,
      };
      return http(request, appSurfaceView(toolBusApp, principal.principal));
    },
  };
}
