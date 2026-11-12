import { buildCommand, buildRouteMap } from "@stricli/core";
import { REMOTE_MCP_CREDENTIAL_KINDS, REMOTE_MCP_RISK_DEFAULTS } from "@every-app/sdk/internal";
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
  brief: "The MCP app (mcp list names them): dataforseo, the id a server was added as, or the server's URL",
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
        values: REMOTE_MCP_CREDENTIAL_KINDS,
        brief:
          "How the Gateway authenticates to the server (default: OAuth when its 401 names resource metadata, none when it answers without a credential)",
        optional: true,
      },
      header: {
        kind: "parsed",
        parse: String,
        brief: "With --auth header: the header the server reads the credential from (X-Api-Key)",
        optional: true,
      },
      prefix: {
        kind: "parsed",
        parse: String,
        brief: "With --auth bearer: the scheme instead of Bearer (Token); with --auth header: what goes before the value",
        optional: true,
      },
      param: {
        kind: "parsed",
        parse: String,
        brief: "With --auth query: the query parameter the server reads the credential from (api_key)",
        optional: true,
      },
      provider: {
        kind: "parsed",
        parse: String,
        brief:
          "Use a provider the Gateway has as the credential (provider list names them): an API key, or an OAuth provider; the URL's host must be one of its hosts",
        placeholder: "id",
        optional: true,
      },
      "client-id": {
        kind: "parsed",
        parse: String,
        brief: "With --auth oauth: a client registered with the server by hand, for a server that registers none itself",
        placeholder: "id",
        optional: true,
      },
      "client-secret-from-env": {
        kind: "parsed",
        parse: String,
        brief: "--client-id's secret, from this environment variable",
        placeholder: "VAR",
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
        brief: "What the app is for, as Admin → Apps and everyapp_list_apps say it (default: the server's own description)",
        optional: true,
      },
      "from-env": {
        kind: "parsed",
        parse: String,
        brief: "With a static --auth: set the credential from this environment variable (as secret set --from-env)",
        placeholder: "VAR",
        optional: true,
      },
      force: {
        kind: "boolean",
        brief: "Add a server that asks for a credential with none (its tools won't list until it has one)",
        optional: true,
      },
      "no-open": {
        kind: "boolean",
        brief: "Print the OAuth connect page without opening it in the browser",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Add any remote MCP server as an MCP app: its tools reach members' AI clients through the Gateway's /mcp",
    fullDescription: [
      "The Gateway serves the server's tools on its own /mcp under <id>_<tool> names, holding the",
      "server's credential itself: every call is attributed to the member, audited and counted",
      "(MCP servers added by URL aren't metered: no cap applies), and read tools are told apart",
      "from write tools. The owners and the admins can use it at once; an admin grants others",
      "in Admin → Apps → Manage access. Nothing is deployed.",
      "",
      "A server that is added already is left as it is: add says where it stands and the one",
      "command that fixes it, and at a terminal offers to connect an account to an OAuth one.",
      "",
      "add looks at the URL once from this machine before writing anything. A server that",
      "answers without a credential is added with none. One whose 401 names its OAuth metadata",
      "is added with OAuth. One that asks for a credential otherwise is refused",
      "(REMOTE_MCP_NEEDS_CREDENTIAL) until you say how it authenticates; --force adds it anyway.",
      "",
      "The credential is a provider: the app's own <id>-mcp row, written beside it, or",
      "--provider <id> for one the Gateway has (its host must be the URL's).",
      "  --auth bearer|header|query|basic: a static value, <ID>_MCP_TOKEN. At a terminal add",
      "    offers to set it (hidden input); --from-env VAR sets it from a variable; later:",
      `    ${CLI} secret set TREG_MCP_TOKEN`,
      "    Once set, add checks it with one tools/list from here. The Gateway sends it only to",
      "    the URL's host.",
      "  --auth oauth: the Gateway signs in to the server. add discovers its authorization",
      "    server and registers a client with it, or, where the server takes client metadata",
      "    documents instead, gives it the URL of the Gateway's own; for a server that takes",
      "    neither, register one with the redirect URI add prints and give --client-id",
      "    (--client-secret-from-env).",
      "    Each member then connects their own account, at the connect page add prints and",
      "    opens (--no-open: print only).",
      "",
      "The Gateway follows no redirects.",
      "",
      "Examples:",
      `  ${CLI} mcp add https://mcp.deepwiki.com/mcp`,
      `  ${CLI} mcp add https://treg.to/mcp/ --auth bearer`,
      `  ${CLI} mcp add https://api.example.org/mcp --name example --auth header --header X-Api-Key --risk read`,
      `  ${CLI} mcp add https://mcp.linear.app/mcp`,
      `  ${CLI} mcp add https://api.elevenlabs.io/v1/mcp`,
    ].join("\n"),
  },
});

const connectCommand = buildCommand({
  loader: async () => {
    const { connectAccount } = await import(".");
    return connectAccount;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: {
      "no-open": {
        kind: "boolean",
        brief: "Print the connect page without opening it in the browser",
        optional: true,
      },
      "no-wait": {
        kind: "boolean",
        brief: "Don't wait for the account to be connected",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Connect an account to an MCP app that signs in with OAuth, or connect it again: opens the Gateway's connect page",
    fullDescription: [
      "For an MCP app whose credential is OAuth (mcp list says OAuth: <n> connected). The",
      "account is connected in the browser, by whoever signs in to the Gateway there: this",
      "command prints the Gateway's connect page and, at a terminal, opens it and waits up to",
      "five minutes for the Gateway to record the connection. A tool listing that had failed is",
      "then tried again on the next request to /mcp. Connecting again replaces that person's",
      "connection: the fix when the server refuses an account that is connected.",
      "",
      "Under --json or with no terminal it prints the page (data.connect.url) and doesn't wait.",
      "",
      "Examples:",
      `  ${CLI} mcp connect linear`,
      `  ${CLI} mcp connect https://mcp.linear.app/mcp --no-open`,
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
    brief: "Remove an MCP app: it leaves /mcp and Admin → Apps, and everyone's access to it goes",
    fullDescription: [
      "Like deleting an app: the Gateway stops serving its tools within 30 seconds, and",
      "everyone's access to it, the personal tokens bound to it, its tools snapshot and its",
      "place in AI connections go with it. Adding it again starts fresh. To stop serving it",
      `and keep all that, turn it off instead: ${CLI} mcp off <id>.`,
      "",
      "Its provider row (<id>-mcp) and the key or client it holds stay, with everyone's OAuth",
      `connections; ${CLI} provider remove <id>-mcp and ${CLI} secret unset <NAME> clean them up.`,
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
      "and counts and audits every call like an app's. It appears under MCP apps in Admin → Apps.",
      "",
      "A built-in's first on adds it: the owners and the admins can use it at once, and an",
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
      "For a remote server: the URL, how the Gateway authenticates, its provider, whether the key",
      "is set (and set for the hosts it has now), or for OAuth who has connected (never a token)",
      "and the connect page, the risk default, when the tools were last listed",
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
    positional: { kind: "tuple", parameters: [{ ...idParameter, optional: true }] },
    flags: connectFlags,
  },
  docs: {
    brief: "Drop an MCP app's tools snapshot, so the Gateway lists its tools again",
    fullDescription: [
      "Only the snapshot goes (the Gateway's copy of the tool list); the app, its access and its",
      "settings stay. The Gateway lists the tools again on the next request to its /mcp, or",
      "within the hour. Use it after the server changed its tools. With no id it changes nothing",
      "and names the apps there are, each with how its last listing went.",
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
        values: ["read", "write", "annotations"],
        brief: "The tool's risk: read or write; annotations drops your override",
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
      "read & write ones; --off keeps a tool from every AI client. The server's hints decide it",
      "unless the app's --risk default or this override says otherwise. The Gateway lists the",
      "tools again on first use. A built-in MCP app's tools are its own and can't be changed",
      "here.",
      "",
      "Examples:",
      `  ${CLI} mcp tool treg delete_everything --off`,
      `  ${CLI} mcp tool treg get_report --risk read`,
      `  ${CLI} mcp tool treg search --risk annotations`,
    ].join("\n"),
  },
});

/**
 * `everyapp mcp add|connect|remove|on|off|list|show|refresh|tool`: MCP apps,
 * provider apps in the code (tier `provider`): the built-in data providers
 * (`PROVIDER_APPS`) and any remote MCP server added by URL. `everyapp
 * provider …` is an alias of the group (app.ts), kept through launch week
 * for documents that still say it. `enable` and `disable` run `on` and
 * `off` for people who type them: aliases, so help, the reference and every
 * hint keep saying `on` and `off` alone.
 */
export const mcpRoutes = buildRouteMap({
  routes: {
    add: addCommand,
    connect: connectCommand,
    remove: removeCommand,
    on: onCommand,
    off: offCommand,
    list: listCommand,
    show: showCommand,
    refresh: refreshCommand,
    tool: toolCommand,
  },
  aliases: { ls: "list", enable: "on", disable: "off" },
  docs: {
    brief: "Offer MCP servers to members' AI clients as MCP apps, with the Gateway holding each one's key",
  },
});
