import { buildCommand, buildRouteMap } from "@stricli/core";
import { REMOTE_MCP_AUTH_KINDS, REMOTE_MCP_RISK_DEFAULTS } from "@every-app/sdk/internal";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const idParameter = {
  placeholder: "id",
  brief: "The MCP app (mcp list names them): dataforseo, or the id a server was added as",
  parse: String,
} as const;

const addCommand = buildCommand({
  loader: async () => {
    const { add } = await import(".");
    return add;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "url",
          brief: "The server's MCP address (https://, the one URL the Gateway ever sends its credential to)",
          parse: String,
        },
      ],
    },
    flags: {
      name: {
        kind: "parsed",
        parse: String,
        brief: "The app's id and tool prefix (default: from the URL's host, https://mcp.treg.to/mcp → treg)",
        optional: true,
      },
      auth: {
        kind: "enum",
        values: REMOTE_MCP_AUTH_KINDS,
        brief:
          "How the Gateway authenticates to the server (default: none; bearer with --secret, header with --header)",
        optional: true,
      },
      header: {
        kind: "parsed",
        parse: String,
        brief: "With --auth header: the header the server reads the credential from (X-Api-Key)",
        optional: true,
      },
      secret: {
        kind: "parsed",
        parse: String,
        brief: "The Gateway setting holding the credential, ending in _MCP_TOKEN (default: <ID>_MCP_TOKEN)",
        optional: true,
      },
      risk: {
        kind: "enum",
        values: REMOTE_MCP_RISK_DEFAULTS,
        brief:
          "How a tool's risk is decided: from the server's hints, unknown as write (annotations, the default), or every tool read or write",
        optional: true,
      },
      description: {
        kind: "parsed",
        parse: String,
        brief: "What the app is for, as Admin → Apps and everyapp_list_apps say it (default: from the URL)",
        optional: true,
      },
      "from-env": {
        kind: "parsed",
        parse: String,
        brief: "Set the credential from this environment variable once the app is added (as secret set --from-env)",
        placeholder: "VAR",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Add any remote MCP server as an MCP app: its tools reach members' AI clients through the Gateway's /mcp",
    fullDescription: [
      "The Gateway serves the server's tools on its own /mcp under <id>_<tool> names, holding the",
      "server's credential itself: every call is attributed to the member, audited, counted and",
      "capped like an app's, and read tools are told apart from write tools (a read-only",
      "connection sees only the read ones). You, the owners and the admins get it at once; an",
      "admin grants others in Admin → Apps → Manage access. Nothing is deployed.",
      "",
      "The credential is a Gateway setting named <ID>_MCP_TOKEN (--secret picks another name",
      "ending in _MCP_TOKEN), pinned to the URL's origin when it is set: the Gateway never sends",
      "it anywhere else. At a terminal, add offers to set it right away (hidden input, as secret",
      "set asks); --from-env VAR sets it from an environment variable; otherwise, afterwards:",
      `  ${CLI} secret set TREG_MCP_TOKEN`,
      "",
      "--auth bearer sends Authorization: Bearer <value>; header sends <header>: <value>; basic",
      "takes user:password; none sends nothing. oauth is recorded but not served yet: the Gateway",
      "doesn't sign in to MCP servers with OAuth this week.",
      "",
      "add looks at the URL once from this machine, without the credential, and says what it",
      "found (MCP, a 401, a redirect, or nothing); that is a warning, never a refusal, since the",
      "Gateway, not this machine, is what fetches it. The Gateway follows no redirects.",
      "",
      "Examples:",
      `  ${CLI} mcp add https://mcp.deepwiki.com/mcp`,
      `  ${CLI} mcp add https://treg.to/mcp/ --auth bearer`,
      `  ${CLI} mcp add https://api.example.org/mcp --name example --auth header --header X-Api-Key --risk read`,
    ].join("\n"),
  },
});

const removeCommand = buildCommand({
  loader: async () => {
    const { remove } = await import(".");
    return remove;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: connectFlags,
  },
  docs: {
    brief: "Remove an MCP app: it leaves /mcp and the home page, and everyone's access to it goes",
    fullDescription: [
      "Like deleting an app: the Gateway stops serving its tools within 30 seconds, and",
      "everyone's access to it, the personal tokens bound to it, its tools snapshot and its",
      "place in AI connections go with it. Adding it again starts fresh. To stop serving it",
      `and keep all that, turn it off instead: ${CLI} mcp off <id>.`,
      "",
      "The Gateway setting holding its key or credential stays, and so does a credential's pin",
      `to its origin; ${CLI} secret unset <NAME> removes both.`,
      "",
      "Example:",
      `  ${CLI} mcp remove treg`,
    ].join("\n"),
  },
});

const onCommand = buildCommand({
  loader: async () => {
    const { on } = await import(".");
    return on;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: connectFlags,
  },
  docs: {
    brief: "Turn an MCP app on: its tools reach members' AI clients through the Gateway's /mcp",
    fullDescription: [
      "An MCP app is a data provider (DataForSEO, built in) or any remote MCP server added with",
      `${CLI} mcp add <url>, offered as an app of the Gateway's own with no page and nothing to`,
      "deploy: the Gateway serves its tools on its /mcp under <id>_<tool> names, with its own key,",
      "and counts and audits every call like an app's. It appears in Admin → Apps and under MCP",
      "apps on the home page.",
      "",
      "A built-in's first on adds it: you, the owners and the admins get it at once, and an",
      "admin grants other members with Manage access. On after off serves it again at once,",
      "with everyone's access kept. The key is a Gateway setting the tools need (mcp list names",
      "it):",
      `  ${CLI} secret set DATAFORSEO_API_KEY`,
      "",
      "Safe to repeat: an app that is on stays on, with its access.",
      "",
      "Examples:",
      `  ${CLI} mcp on dataforseo`,
      `  ${CLI} mcp on treg --json`,
    ].join("\n"),
  },
});

const offCommand = buildCommand({
  loader: async () => {
    const { off } = await import(".");
    return off;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: connectFlags,
  },
  docs: {
    brief: "Turn an MCP app off: its tools leave /mcp, and everyone's access is kept for on",
    fullDescription: [
      "The Gateway stops serving the app's tools within 30 seconds and the home page stops",
      "listing it. Everyone's access, the personal tokens bound to it and its tools snapshot",
      `are kept, so ${CLI} mcp on <id> serves it again at once. To remove it for good, with`,
      `all of that: ${CLI} mcp remove <id>.`,
      "",
      "(Until 2026-10-25 off removed the app; that is remove now.)",
      "",
      "Example:",
      `  ${CLI} mcp off dataforseo`,
    ].join("\n"),
  },
});

const listCommand = buildCommand({
  loader: async () => {
    const { list } = await import(".");
    return list;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: connectFlags },
  docs: {
    brief: "List the MCP apps: built-in and added, on or off, their tools and whether each key is set",
    fullDescription: [
      "Nothing is changed. A key's value can't be read back; only whether it is set.",
      "",
      "Example:",
      `  ${CLI} mcp list`,
    ].join("\n"),
  },
});

const showCommand = buildCommand({
  loader: async () => {
    const { show } = await import(".");
    return show;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: connectFlags,
  },
  docs: {
    brief: "Show an MCP app: its address, credential, status, last tool listing and every tool with its risk",
    fullDescription: [
      "For a remote server: the URL, how the Gateway authenticates, the credential's name, whether",
      "it is set and the origin it is pinned to, the risk default, when the tools were last listed",
      "(and the error if that failed), then every tool the server listed: its name on the Gateway,",
      "the server's own name, its risk and where that comes from (the server's hint, the app's",
      "default, your override), and whether it is on. Nothing is changed.",
      "",
      "Examples:",
      `  ${CLI} mcp show treg`,
      `  ${CLI} mcp show dataforseo --json`,
    ].join("\n"),
  },
});

const refreshCommand = buildCommand({
  loader: async () => {
    const { refresh } = await import(".");
    return refresh;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: connectFlags,
  },
  docs: {
    brief: "Drop an MCP app's tools snapshot, so the Gateway lists its tools again",
    fullDescription: [
      "Only the snapshot goes (the Gateway's copy of the tool list); the app, its access and its",
      "settings stay. The Gateway lists the tools again on the next request to its /mcp, or",
      "within the hour. Use it after the server changed its tools.",
      "",
      "Example:",
      `  ${CLI} mcp refresh treg`,
    ].join("\n"),
  },
});

const toolCommand = buildCommand({
  loader: async () => {
    const { tool } = await import(".");
    return tool;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        idParameter,
        {
          placeholder: "tool",
          brief: "The tool: the server's name for it, or its name on the Gateway (mcp show lists both)",
          parse: String,
        },
      ],
    },
    flags: {
      risk: {
        kind: "enum",
        values: ["read", "write", "destructive", "annotations"],
        brief:
          "The tool's risk: read, write or destructive (hidden until approvals exist); annotations drops your override",
        optional: true,
      },
      on: { kind: "boolean", brief: "List the tool (the default)", optional: true },
      off: { kind: "boolean", brief: "Leave the tool out: it isn't listed, and a call answers Unknown tool", optional: true },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Override one tool of a remote MCP app: its risk, or whether it is listed at all",
    fullDescription: [
      "A tool's risk decides who can call it: read tools every connection, write tools only",
      "read & write ones, destructive tools nobody until approvals exist. The server's hints",
      "decide it unless the app's --risk default or this override says otherwise. The Gateway",
      "lists the tools again on first use. A built-in MCP app's tools are its own and can't be",
      "changed here.",
      "",
      "Examples:",
      `  ${CLI} mcp tool treg delete_everything --risk destructive`,
      `  ${CLI} mcp tool treg treg_noisy_tool --off`,
      `  ${CLI} mcp tool treg search --risk annotations`,
    ].join("\n"),
  },
});

/**
 * `everyapp mcp add|remove|on|off|list|show|refresh|tool`: MCP apps,
 * provider apps in the code (tier `provider`): the built-in data providers
 * (`PROVIDER_APPS`) and any remote MCP server added by URL. `everyapp
 * provider …` is an alias of the group (app.ts), kept through launch week
 * for documents that still say it.
 */
export const mcpRoutes = buildRouteMap({
  routes: {
    add: addCommand,
    remove: removeCommand,
    on: onCommand,
    off: offCommand,
    list: listCommand,
    show: showCommand,
    refresh: refreshCommand,
    tool: toolCommand,
  },
  aliases: { ls: "list" },
  docs: {
    brief: "Offer MCP servers to members' AI clients as MCP apps, with the Gateway holding each one's key",
  },
});
