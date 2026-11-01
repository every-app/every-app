/**
 * The MCP app tools: Admin → Apps' MCP apps and `everyapp mcp …` as
 * workspace tools on the gateway's own /mcp, under `everyapp_mcp_*`
 * (docs/design/2026-10-mcp-by-url.md, section 4, "The agent"). An MCP app
 * is a built-in provider app (DataForSEO) or a remote MCP server added by
 * URL; these list and show them, add a server, turn one on or off, list
 * its tools again, change one tool, and remove one.
 *
 * They are workspace tools like the rest (workspace.ts lists them in
 * WORKSPACE_TOOLS, after its own): the same kind `host`, the same
 * policy, listing and audit. Only the definitions live here; the gateway's
 * handlers are apps/every-app-gateway/src/server/toolbus/mcp-app-tools.ts.
 * The two schema helpers below are this file's own, since workspace.ts
 * imports this one.
 *
 * No tool takes or returns a credential: `auth.secret` is the NAME of the
 * Gateway setting that holds it, and the answer names the command the
 * operator runs to set it (`pnpm everyapp secret set <NAME>`), so the
 * value is typed in a terminal and never passes through an AI client.
 */
import {
  REMOTE_MCP_AUTH_KINDS,
  REMOTE_MCP_RISK_DEFAULTS,
  TOOL_RISKS,
} from "@every-app/sdk/internal";
import type { JsonObject } from "./types";
import type { WorkspaceToolDefinition } from "./workspace";

/** An MCP app's id (at most 32 characters) or its row id (a UUID). */
const APP_REF_MAX = 64;
/** The remote rules' bounds (packages/sdk/src/internal/remoteMcp.ts). */
const URL_MAX = 2048;
const REMOTE_ID_MAX = 32;
const NAME_MAX = 255;
const DESCRIPTION_MAX = 1000;
const SECRET_MAX = 64;
const HEADER_MAX = 100;
const PREFIX_MAX = 32;
const TOOL_NAME_MAX = 256;

const text = (description: string, maxLength: number, minLength = 1) => ({
  type: "string",
  description,
  minLength,
  maxLength,
});

function closed(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonObject {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

const APP = text(
  "The MCP app: its id, the prefix of its tools (`treg` for `treg_<tool>`, as everyapp_mcp_list lists it), or its row id.",
  APP_REF_MAX,
);

const ADMIN_READ = { risk: "read", minRole: "admin" } as const;
const ADMIN_WRITE = { risk: "write", minRole: "admin" } as const;

/** The MCP app tools, in the order tools/list shows them. */
export const MCP_APP_TOOLS: readonly WorkspaceToolDefinition[] = [
  {
    ...ADMIN_READ,
    name: "mcp_list",
    title: "List MCP apps",
    description:
      "List the organization's MCP apps: the built-in ones (DataForSEO) that were added and every remote MCP server added by URL. Each with its id, name, kind (builtin or remote), status (on; off; or needs setup: on, but its credential isn't set or is pinned to another server), how many tools the Gateway serves, a remote server's URL and auth kind, and the credential's setting name with whether it is set and bound. Never a credential's value. Owners and admins.",
    inputSchema: closed({}),
  },
  {
    ...ADMIN_READ,
    name: "mcp_show",
    title: "Show an MCP app",
    description:
      "Show one MCP app: its URL and auth kind, the credential's setting name and whether it is set and bound (never its value), its status, when its tools were last listed and the error if that failed, and every tool: the name AI clients call, the server's own name, its risk and where that comes from (override, app, hint or default), whether it is on, and why it isn't listed. Owners and admins.",
    inputSchema: closed({ app: APP }, ["app"]),
  },
  {
    ...ADMIN_WRITE,
    name: "mcp_add",
    title: "Add an MCP server",
    description:
      "Add a remote MCP server by its URL as an MCP app: the Gateway serves its tools on /mcp as `<id>_<tool>` to whoever has access (you, the owners and the admins to start). For a server with no credential the Gateway lists its tools at once and the answer says how many. For one with a credential the answer names the Gateway setting that holds it and the command the operator runs in a terminal to set it; the credential itself is never passed here and never returned. Refused for a URL on this Gateway's own domains or a private address, an id in use, or a credential name another server uses. Owners and admins.",
    inputSchema: closed(
      {
        url: text(
          "The server's MCP endpoint, https (`https://treg.to/mcp`).",
          URL_MAX,
        ),
        id: text(
          "The app id and tool prefix: lowercase letters, digits and hyphens, a letter first. Default: from the URL's host (`treg.to` → `treg`).",
          REMOTE_ID_MAX,
        ),
        name: text("The name people read. Default: the id.", NAME_MAX),
        description: text(
          "What the server is for. Default: a sentence naming it and its host.",
          DESCRIPTION_MAX,
        ),
        auth: {
          description:
            "How the Gateway authenticates to the server; for a credential, the name of the setting that holds it.",
          ...closed(
            {
              kind: {
                type: "string",
                description:
                  "How the Gateway authenticates to the server: none; bearer (`Authorization: Bearer <credential>`); header (a header of your naming); basic (the credential is `user:password`); oauth (recorded, not served yet).",
                enum: [...REMOTE_MCP_AUTH_KINDS],
              },
              secret: text(
                "The NAME of the Gateway setting that holds the credential, ending in _MCP_TOKEN. Default: `<ID>_MCP_TOKEN`. Never the credential itself.",
                SECRET_MAX,
              ),
              header: text(
                "For kind header: the header's name (`X-Api-Key`).",
                HEADER_MAX,
              ),
              prefix: text(
                "For kind header: text sent before the credential (`Token `). Optional.",
                PREFIX_MAX,
                0,
              ),
            },
            ["kind"],
          ),
        },
        risk: {
          type: "string",
          description:
            "How each tool's risk is decided: annotations (the server's hints; a tool without one counts as write; the default), or read or write for every tool.",
          enum: [...REMOTE_MCP_RISK_DEFAULTS],
        },
      },
      ["url", "auth"],
    ),
  },
  {
    ...ADMIN_WRITE,
    name: "mcp_remove",
    title: "Remove an MCP app",
    description:
      "Remove an MCP app, built-in or remote: it stops being served, and everyone's access, its tokens, its tools snapshot and its place in AI connections go. The credential stays set on the Gateway. To stop serving it and keep all that, use everyapp_mcp_off. Cannot be undone: needs confirm: true. Owners and admins.",
    inputSchema: closed(
      {
        app: APP,
        confirm: {
          type: "boolean",
          description:
            "Must be true. The action cannot be undone; ask the person before calling.",
          const: true,
        },
      },
      ["app", "confirm"],
    ),
    irreversible: true,
  },
  {
    ...ADMIN_WRITE,
    name: "mcp_on",
    title: "Turn an MCP app on",
    description:
      "Serve an MCP app's tools again, to the same people as before. A built-in that was never added is added by the operator (`pnpm everyapp mcp on <id>`). Owners and admins.",
    inputSchema: closed({ app: APP }, ["app"]),
  },
  {
    ...ADMIN_WRITE,
    name: "mcp_off",
    title: "Turn an MCP app off",
    description:
      "Stop serving an MCP app's tools. Who has access, their tokens and the tools snapshot are kept, so everyapp_mcp_on brings it back at once. Owners and admins.",
    inputSchema: closed({ app: APP }, ["app"]),
  },
  {
    ...ADMIN_WRITE,
    name: "mcp_refresh",
    title: "List an MCP app's tools again",
    description:
      "List an MCP app's tools again now: the Gateway drops its last listing, asks the server, and answers how many tools it serves and which names are new or gone. Owners and admins.",
    inputSchema: closed({ app: APP }, ["app"]),
  },
  {
    ...ADMIN_WRITE,
    name: "mcp_tool",
    title: "Change one tool of an MCP server",
    description:
      "Change one tool of a remote MCP app: its risk (read, write or destructive; annotations goes back to the server's hint and the app's default) and whether it is on. A destructive tool is never served to AI clients until approvals exist; a write tool is hidden from read-only connections. Give `risk`, `enabled`, or both. Owners and admins.",
    inputSchema: closed(
      {
        app: APP,
        tool: text(
          "The tool: the name AI clients call (`treg_get_user`) or the server's own (`getUser`), as everyapp_mcp_show lists them.",
          TOOL_NAME_MAX,
        ),
        risk: {
          type: "string",
          description:
            "The tool's risk, or annotations to clear your override.",
          enum: [...TOOL_RISKS, "annotations"],
        },
        enabled: {
          type: "boolean",
          description:
            "false leaves the tool out of the catalog; true serves it again.",
        },
      },
      ["app", "tool"],
    ),
  },
];
