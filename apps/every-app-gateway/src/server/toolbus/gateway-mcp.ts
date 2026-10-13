/**
 * The gateway's own `${GATEWAY_URL}/mcp`: one MCP server for every app a
 * caller may use, under `<appId>_<tool>` names, plus the built-in
 * `everyapp_*` tools.
 *
 * The caller is already resolved (mcp-auth/validate.ts): an OAuth connection
 * or a personal access token. This reads, from D1 only, the serving catalogs
 * of the apps the caller reaches: active apps of their organization they
 * have access to, narrowed to the connection's chosen apps or the token's
 * app. It never asks an app for its tools; `tools/call` reaches exactly one
 * app over its service binding, with an identity minted for that call.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import type { McpCaller } from "@/server/mcp-auth/validate";
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

  let catalogs;
  try {
    catalogs = await AppToolRepository.findVisibleCatalogs({
      organizationId: principal.organizationId,
      userId: principal.userId,
      ...caller.apps,
    });
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
        name: catalog.name,
        ...(catalog.description ? { description: catalog.description } : {}),
        baseUrl: `https://${catalog.hostname}`,
        catalogHash: catalog.catalogHash,
        ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
        tools: catalog.tools,
      },
      {
        rowId: catalog.appRowId,
        organizationId: principal.organizationId,
        appSlug: catalog.appSlug,
        hostname: catalog.hostname,
        workerName: catalog.workerName,
        tier: catalog.tier,
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
