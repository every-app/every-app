/**
 * Tool names as clients see them. An app host serves an app's local names
 * (`create_todo`), so existing per-app connections keep working. Where one
 * endpoint fronts several apps, names are `<appId>_<tool>` (`todo_create_todo`).
 * App ids are kebab-case and never contain "_", so the first "_" always ends
 * the prefix.
 */
import type { ToolBusApp, ToolBusTool, ToolBusView } from "./types";

/**
 * The longest name every major MCP client accepts. The spec allows 128 and
 * ".", but staying within `[A-Za-z0-9_-]{1,64}` keeps every client working.
 */
export const MAX_TOOL_NAME_LENGTH = 64;
/** The spec's limit for a tool name; a client's longer name is no tool. */
export const MAX_CALLED_NAME_LENGTH = 128;

/** A client-supplied name, cut to the spec's limit for logs and errors. */
export function displayedToolName(name: string): string {
  return name.length > MAX_CALLED_NAME_LENGTH
    ? `${name.slice(0, MAX_CALLED_NAME_LENGTH)}…`
    : name;
}

export function namespacedToolName(appId: string, localName: string): string {
  return `${appId}_${localName}`;
}

export function splitNamespacedToolName(
  name: string,
): { appId: string; localName: string } | null {
  const separator = name.indexOf("_");
  if (separator <= 0 || separator === name.length - 1) return null;
  return {
    appId: name.slice(0, separator),
    localName: name.slice(separator + 1),
  };
}

/** The name `tool` is listed and called under on this view's surface. */
export function exposedToolName(
  view: ToolBusView,
  app: ToolBusApp,
  tool: ToolBusTool,
): string {
  return view.surface === "app"
    ? tool.name
    : namespacedToolName(app.appId, tool.name);
}

/** Find the app and tool a client-supplied name refers to, if any. */
export function resolveToolName(
  view: ToolBusView,
  name: string,
): { app: ToolBusApp; tool: ToolBusTool } | null {
  let appId: string | undefined;
  let localName = name;
  if (view.surface === "gateway") {
    const split = splitNamespacedToolName(name);
    if (!split) return null;
    ({ appId, localName } = split);
  }
  const app =
    view.surface === "app"
      ? view.apps[0]
      : view.apps.find((candidate) => candidate.appId === appId);
  const tool = app?.tools.find((candidate) => candidate.name === localName);
  return app && tool ? { app, tool } : null;
}
