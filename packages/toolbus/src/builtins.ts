/**
 * Tools the gateway answers itself on its multi-app surface, without calling
 * any app: who the caller is, and which apps they reach. They are named under
 * `everyapp`, an app id no manifest may take, are read-only, are listed
 * before every app's tools, and are marked to stay loaded in Claude Code.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolCallResultV1 } from "@every-app/sdk/internal";
import { namespacedToolName } from "./names";
import { evaluateToolPolicy } from "./policy";
import type { ToolBusApp, ToolBusTool, ToolBusView } from "./types";

/** The reserved app id the built-in tools are namespaced under. */
export const BUILTIN_APP_ID = "everyapp";

/**
 * Claude Code defers every MCP tool behind its tool search unless the
 * server sets this key in the tool's `_meta` (read since 2.1.285). The
 * built-ins are how a model finds its way in (which apps exist, who it acts
 * as), so they stay loaded while app tools stay deferred. A person's
 * server-level `alwaysLoad: false` still wins (2.1.287 and later); other
 * clients ignore the key.
 */
const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

interface BuiltinTool extends ToolBusTool {
  run(view: ToolBusView): Record<string, unknown>;
}

const NO_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function visibleToolCount(view: ToolBusView, app: ToolBusApp): number {
  return app.tools.filter(
    (tool) => evaluateToolPolicy(tool, view.principal).action === "allow",
  ).length;
}

const BUILTINS: BuiltinTool[] = [
  {
    name: "list_apps",
    title: "List apps",
    description:
      "List the Every App apps this connection can use: what each is for, its URL, and how many tools it offers. Tool names are `<app>_<tool>`. An app that isn't available yet (it needs setup) says so, with what an admin runs.",
    risk: "read",
    inputSchema: NO_INPUT,
    run: (view) => ({
      apps: [
        ...view.apps.map((app) => ({
          id: app.appId,
          name: app.name,
          ...(app.description ? { description: app.description } : {}),
          url: app.baseUrl,
          tools: visibleToolCount(view, app),
        })),
        ...(view.unavailable ?? []).map((app) => ({
          id: app.appId,
          name: app.name,
          available: false,
          reason: app.reason,
        })),
      ],
    }),
  },
  {
    name: "whoami",
    title: "Who am I",
    description:
      "Show who this connection acts as: the user, their organization and role, the access it was granted, and the apps it can use.",
    risk: "read",
    inputSchema: NO_INPUT,
    run: ({ principal, apps }) => ({
      user: { email: principal.email, role: principal.orgRole },
      organization: {
        id: principal.organizationId,
        ...(principal.organizationName
          ? { name: principal.organizationName }
          : {}),
      },
      connection: {
        kind: principal.credential.kind,
        access: principal.access === "write" ? "read & write" : "read only",
        ...(principal.credential.clientName
          ? { client: principal.credential.clientName }
          : {}),
      },
      apps: apps.map((app) => app.appId),
    }),
  },
];

/** The built-in tools as tools/list shows them, in a stable order. */
export function listBuiltinTools(): Tool[] {
  return BUILTINS.map((tool) => ({
    name: namespacedToolName(BUILTIN_APP_ID, tool.name),
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { [ALWAYS_LOAD_META_KEY]: true },
  }));
}

/** The built-in a local name (after `everyapp_`) refers to, if any. */
export function findBuiltinTool(localName: string): BuiltinTool | null {
  return BUILTINS.find((tool) => tool.name === localName) ?? null;
}

/** Run a built-in: its answer as JSON text and as structured content. */
export function runBuiltinTool(
  tool: BuiltinTool,
  view: ToolBusView,
): ToolCallResultV1 {
  const data = tool.run(view);
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}
