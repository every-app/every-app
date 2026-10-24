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
 * How much of a server's instructions Claude Code shows the model: the first
 * 4,096 characters (its MCP docs, "Scale with MCP tool search"; 2,048 before
 * 2.1.296; `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` changes it). Codex reads
 * the first 512. The head of the gateway's instructions (the header, the app
 * list and the "not available" lines) should stay inside this, so the app
 * list is always what Claude sees. Nothing here clips the head; view.test.ts
 * checks it on the launch apps, and if that ever fails the fix is to shorten
 * those lines, not the apps' guidance.
 */
export const CLAUDE_CODE_INSTRUCTIONS_READ = 4096;

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

const byAppId = <T extends { appId: string }>(a: T, b: T) =>
  a.appId < b.appId ? -1 : 1;

/**
 * The part of the gateway's instructions every client reads: the header, the
 * app list and one line per app that needs setup. It comes before any app's
 * own guidance, which a client may cut (`CLAUDE_CODE_INSTRUCTIONS_READ`).
 */
export function gatewayInstructionsHead(
  principal: McpPrincipal,
  apps: ToolBusApp[],
  unavailable: UnavailableApp[],
): string {
  const sorted = [...apps].sort(byAppId);
  return [
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
  ].join("\n");
}

function gatewayInstructions(
  principal: McpPrincipal,
  apps: ToolBusApp[],
  unavailable: UnavailableApp[],
): string {
  let text = gatewayInstructionsHead(principal, apps, unavailable);
  // Each app's guidance follows, clipped; a later app's block is dropped
  // whole once the total reaches the cap. The cap never cuts the head: a
  // partial app list would mislead more than a long one.
  for (const app of [...apps].sort(byAppId)) {
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
