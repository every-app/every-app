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
 * No tool takes or returns a credential (docs/design/2026-11-mcp-apps-auth.md):
 * a server's credential is a provider. A static one becomes the app's own
 * provider row and the answer names the command the operator runs to set
 * its value (`pnpm everyapp secret set <APPID>_MCP_TOKEN`), so the value is
 * typed in a terminal and never passes through an AI client; OAuth is
 * added with a client the server registers (a pasted client is Admin →
 * Apps' alone) and each member connects their own account at the link the
 * answer gives.
 */
import {
  REMOTE_MCP_CREDENTIAL_KINDS,
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
const PROVIDER_MAX = 40;
const PARAM_MAX = 100;
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
      "List the organization's MCP apps: the built-in ones (DataForSEO) that were added and every remote MCP server added by URL. Each with its id, name, kind (builtin or remote), status (on; off; or needs setup: on, but its key isn't set or was set for other hosts, its OAuth provider has no client or nobody has connected it, or its provider is gone), how many tools the Gateway serves, a remote server's URL and its credential's provider: an API key's setting name with whether it is set and bound, or an OAuth provider's connection count and connect link. Never a credential's value. Owners and admins.",
    inputSchema: closed({}),
  },
  {
    ...ADMIN_READ,
    name: "mcp_show",
    title: "Show an MCP app",
    description:
      "Show one MCP app: its URL and its credential's provider (an API key's setting name and whether it is set and bound, never its value; an OAuth provider's connections and connect link), its status, when its tools were last listed and the error if that failed, and every tool: the name AI clients call, the server's own name, its risk and where that comes from (override, app, hint or default), whether it is on, and why it isn't listed. Owners and admins.",
    inputSchema: closed({ app: APP }, ["app"]),
  },
  {
    ...ADMIN_WRITE,
    name: "mcp_add",
    title: "Add an MCP server",
    description:
      "Add a remote MCP server by its URL as an MCP app: the Gateway serves its tools on /mcp as `<id>_<tool>` to whoever has access (the owners and the admins to start). For a server with no credential the Gateway lists its tools at once and the answer says how many. A static credential (bearer, header, query, basic) becomes the app's own provider `<id>-mcp`: the answer names its setting and the command the operator runs in a terminal to set it. OAuth: the Gateway finds how the server signs in and registers itself as a client, and each member connects their own account at the connect link the answer gives (a server that can't register clients is added in Admin → Apps or from the CLI with a client id). Or name an existing provider whose hosts include the URL's (`provider`). The credential itself is never passed here and never returned. Refused for a URL on this Gateway's own domains or a private address, an id in use, or a provider that doesn't send its credential to the URL's host. Owners and admins.",
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
            "How the Gateway authenticates to the server. Never carries a value.",
          ...closed(
            {
              kind: {
                type: "string",
                description:
                  "none; bearer (`Authorization: Bearer <credential>`); header (a header of your naming); query (a query parameter on the URL); basic (the credential is `user:password`); oauth (members sign in to the server with their own accounts); provider (an existing provider of this Gateway, named in `provider`).",
                enum: [...REMOTE_MCP_CREDENTIAL_KINDS, "provider"],
              },
              header: text(
                "For kind header: the header's name (`X-Api-Key`).",
                HEADER_MAX,
              ),
              prefix: text(
                "For kind header: text sent before the credential (`Token `); for bearer: another scheme. Optional.",
                PREFIX_MAX,
                0,
              ),
              param: text(
                "For kind query: the parameter's name (`api_key`).",
                PARAM_MAX,
              ),
              provider: text(
                "For kind provider: its id, as everyapp_provider_list lists it (`elevenlabs`).",
                PROVIDER_MAX,
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
      "Remove an MCP app, built-in or remote: it stops being served, and everyone's access, its tokens, its tools snapshot and its place in AI connections go. Its provider and the key or client it holds stay on the Gateway. To stop serving it and keep all that, use everyapp_mcp_off. Cannot be undone: needs confirm: true. Owners and admins.",
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
      "Change one tool of a remote MCP app: its risk (read or write; annotations goes back to the server's hint and the app's default) and whether it is on. A write tool is hidden from read-only connections; turn a tool off to keep it from every AI client. Give `risk`, `enabled`, or both. Owners and admins.",
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
