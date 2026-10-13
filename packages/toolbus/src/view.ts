import type { McpPrincipal, ToolBusApp, ToolBusView } from "./types";

/**
 * The view for `<app-host>/mcp`: one app, its local tool names, its own
 * instructions.
 */
export function appSurfaceView(
  app: ToolBusApp,
  principal: McpPrincipal,
  requestId?: string,
): ToolBusView {
  return {
    surface: "app",
    principal,
    apps: [app],
    serverInfo: { name: `every-app-${app.appId}`, title: app.name },
    ...(app.instructions ? { instructions: app.instructions } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
