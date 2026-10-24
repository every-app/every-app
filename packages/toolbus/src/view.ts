import { BUILTIN_APP_ID } from "./builtins";
import type {
  McpPrincipal,
  ToolBusApp,
  ToolBusView,
  UnavailableApp,
} from "./types";

/** Each app's own instructions are cut to this on the gateway surface. */
const MAX_APP_INSTRUCTIONS = 1024;
/** And all of them together to this, so many apps can't flood the context. */
const MAX_GATEWAY_INSTRUCTIONS = 8 * 1024;

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

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function gatewayInstructions(
  principal: McpPrincipal,
  apps: ToolBusApp[],
  unavailable: UnavailableApp[],
): string {
  const byAppId = <T extends { appId: string }>(a: T, b: T) =>
    a.appId < b.appId ? -1 : 1;
  const sorted = [...apps].sort(byAppId);
  const lines = [
    `Tools for ${principal.organizationName ?? "your organization"} on Every App. Each tool is named \`<app>_<tool>\`; call ${BUILTIN_APP_ID}_list_apps to see what each app is for.`,
    sorted.length
      ? `Apps: ${sorted.map((app) => `${app.appId} (${app.name})`).join(", ")}.`
      : "No apps are available to this connection yet.",
    // An app that needs setup has no tools here; the client can still tell
    // its user what to do, since the reason carries the command.
    ...[...unavailable]
      .sort(byAppId)
      .map(
        (app) => `${app.appId} (${app.name}) is not available: ${app.reason}.`,
      ),
  ];
  let text = lines.join("\n");
  for (const app of sorted) {
    if (!app.instructions) continue;
    const block = `\n\n${app.appId}: ${clip(app.instructions, MAX_APP_INSTRUCTIONS)}`;
    if (text.length + block.length > MAX_GATEWAY_INSTRUCTIONS) break;
    text += block;
  }
  return text;
}

/**
 * The view for the gateway's own `/mcp`: every app the caller may reach,
 * under `<appId>_<tool>` names, with the built-in `everyapp_*` tools. The
 * apps the caller reaches but can't use yet (`unavailable`: they need
 * setup) serve no tools; the instructions and `everyapp_list_apps` say why.
 */
export function gatewaySurfaceView(
  principal: McpPrincipal,
  apps: ToolBusApp[],
  options: {
    requestId?: string;
    allowedOrigins?: readonly string[];
    unavailable?: UnavailableApp[];
  } = {},
): ToolBusView {
  const unavailable = options.unavailable ?? [];
  return {
    surface: "gateway",
    principal,
    apps,
    ...(unavailable.length ? { unavailable } : {}),
    serverInfo: {
      name: "every-app",
      title: principal.organizationName
        ? `${principal.organizationName} · Every App`
        : "Every App",
    },
    instructions: gatewayInstructions(principal, apps, unavailable),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.allowedOrigins?.length
      ? { allowedOrigins: options.allowedOrigins }
      : {}),
  };
}
