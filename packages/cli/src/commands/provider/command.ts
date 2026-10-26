import { buildCommand, buildRouteMap } from "@stricli/core";
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
  brief: "The provider's id (provider list names them): stripe",
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
          placeholder: "provider",
          brief: "A built-in provider's id (openrouter, google-workspace, github-oauth), or a spec: a JSON file or an https URL to one (64 KiB at most)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      replace: {
        kind: "boolean",
        brief: "Replace the provider registered under the spec's id; its key must be set again",
        optional: true,
      },
      oauth: {
        kind: "parsed",
        parse: String,
        placeholder: "preset",
        brief: "An OAuth provider: a preset (provider presets names them: github-oauth), a built-in client (google-workspace), or a JSON spec file with auth.kind oauth2-user",
        optional: true,
      },
      "client-id": {
        kind: "parsed",
        parse: String,
        placeholder: "id",
        brief: "An OAuth provider's client id (public); the secret comes from the prompt, piped NAME=value lines or --from-env",
        optional: true,
      },
      "from-env": {
        kind: "boolean",
        brief: "Set the key or client from the environment variables of its setting names (OPENROUTER_API_KEY; GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET); nothing is asked",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Add a provider and set its key or OAuth client in one step, so apps can list it",
    fullDescription: [
      "Says the one thing to do at the provider (create a key, or register the redirect URI and",
      "make an OAuth client), links its page on everyapp.com, then asks for the key or client at",
      "hidden prompts and sets it on the Gateway as secret set would. Live at once; no deploy.",
      "",
      "Nobody at a terminal (--json, piped, CI), or Enter on nothing: nothing is set, and it prints",
      "the one command to run next:",
      `  ${CLI} secret set OPENROUTER_API_KEY`,
      "Scripts and agents set it in the same run with --from-env (the variables of the settings'",
      "names) or piped NAME=value lines; never on the command line.",
      "",
      "A built-in provider (provider list names them) is only its key; an OAuth client",
      "(google-workspace, slack, microsoft-365, discord) its client. An OAuth preset (provider",
      "presets: github-oauth) becomes a registered provider. Any other API is a spec: its id, name,",
      "the page the key comes from (docs), the only hosts the key is ever sent to and how (auth:",
      "bearer, header, query or basic), naming the Gateway setting that holds the key. The spec",
      "never holds the key. A URL is fetched on this machine. The rules a spec must pass: an id",
      "that isn't a built-in provider's, settings named after the id that nothing else reads, and",
      "public hosts that aren't the Gateway's own or its apps'. Run in an app's directory, it also",
      "writes .everyapp/providers/<id>.json for everyapp dev (your key goes in .dev.vars).",
      "",
      "--oauth takes an OAuth spec file (auth.kind oauth2-user), or a preset or built-in client by",
      "name. --verbose adds an OAuth provider's scope sets and the manifest entry.",
      "",
      "Examples:",
      `  ${CLI} provider add google-workspace`,
      `  ${CLI} provider add openrouter`,
      `  OPENROUTER_API_KEY=sk-or-... ${CLI} provider add openrouter --from-env`,
      `  ${CLI} provider add github-oauth`,
      `  printf 'GITHUB_OAUTH_CLIENT_SECRET=%s\\n' "$SECRET" | ${CLI} provider add github-oauth --client-id Iv1.abc`,
      `  ${CLI} provider add stripe.json`,
      `  ${CLI} provider add https://example.com/providers/stripe.json --replace`,
      `  ${CLI} provider add --oauth ./acme.json --from-env`,
    ].join("\n"),
  },
});

const presetsCommand = buildCommand({
  loader: async () => {
    const { presets } = await import(".");
    return presets;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: { json: jsonFlag, verbose: verboseFlag } },
  docs: {
    brief: "List the OAuth presets provider add --oauth takes: GitHub, Notion, Linear and more, and the built-in clients",
    fullDescription: [
      "Each with its scope sets (what an app lists under scopes) and the console where its client",
      "is made. Nothing is read from the Gateway.",
      "",
      "Example:",
      `  ${CLI} provider presets`,
    ].join("\n"),
  },
});

const connectionsCommand = buildCommand({
  loader: async () => {
    const { connections } = await import(".");
    return connections;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      all: {
        kind: "boolean",
        brief: "Every organization's connections (default: the Gateway's own organization's)",
        optional: true,
      },
      user: {
        kind: "parsed",
        parse: String,
        placeholder: "email",
        brief: "One person's connections",
        optional: true,
      },
      provider: {
        kind: "parsed",
        parse: String,
        placeholder: "id",
        brief: "One provider's connections",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "List the accounts people (and the organization) connected to OAuth providers on the Gateway",
    fullDescription: [
      "Who connected what, with the scope sets granted, the status and when it was last used.",
      "Never a token.",
      "",
      "Examples:",
      `  ${CLI} provider connections`,
      `  ${CLI} provider connections --provider github-oauth`,
      `  ${CLI} provider connections --user ben@example.com`,
    ].join("\n"),
  },
});

const disconnectCommand = buildCommand({
  loader: async () => {
    const { disconnect } = await import(".");
    return disconnect;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [{ ...idParameter, brief: "The OAuth provider's id: github-oauth" }] },
    flags: {
      user: {
        kind: "parsed",
        parse: String,
        placeholder: "email",
        brief: "This person's connection",
        optional: true,
      },
      organization: {
        kind: "boolean",
        brief: "The organization's own connection (the one background work uses)",
        optional: true,
      },
      all: {
        kind: "boolean",
        brief: "Every connection to the provider",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Remove a person's or the organization's connection to an OAuth provider from the Gateway",
    fullDescription: [
      "The Gateway drops the tokens it held; apps get \"not connected\" until the person connects",
      "again at /connect/<id>. The CLI holds no token, so the grant stays at the provider until it",
      "is revoked there (Admin → Providers → Disconnect revokes it from the Gateway).",
      "",
      "Examples:",
      `  ${CLI} provider disconnect github-oauth --user ben@example.com`,
      `  ${CLI} provider disconnect github-oauth --organization`,
      `  ${CLI} provider disconnect github-oauth --all`,
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
    brief: "List the API providers the Gateway offers: built in and registered, each key's state, the apps using each",
    fullDescription: [
      "Nothing is changed. A key's value can't be read back; only whether it is set, and for a",
      "registered provider whether it was set for the hosts the row names now (bound).",
      "",
      "Example:",
      `  ${CLI} provider list`,
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
    flags: {
      save: {
        kind: "boolean",
        brief: "Also write the spec to .everyapp/providers/<id>.json in this app's directory, for everyapp dev",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Print a provider's spec: its hosts, how its key is sent, its settings, who registered it and which apps use it",
    fullDescription: [
      "What an agent reads to set up and call a provider without a setup guide. With --save, in an",
      "app's directory, the spec is written where everyapp dev reads it.",
      "",
      "Examples:",
      `  ${CLI} provider show stripe`,
      `  ${CLI} provider show stripe --save`,
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
    flags: {
      force: {
        kind: "boolean",
        brief: "Remove it even though deployed apps list it (their calls to it stop)",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Remove a registered provider from the Gateway; its key stays set until secret unset",
    fullDescription: [
      "The Gateway stops serving it within 30 seconds. A provider a deployed app lists under",
      "capabilities is refused unless --force. The Gateway setting holding its key stays; remove",
      `it with ${CLI} secret unset <NAME>. Registering it again needs the key set again too.`,
      "",
      "Example:",
      `  ${CLI} provider remove stripe`,
    ].join("\n"),
  },
});

const providerParameter = {
  placeholder: "provider",
  brief: "A built-in OAuth client with scope sets: google-workspace, microsoft-365 or slack",
  parse: String,
} as const;

const scopeSetAddCommand = buildCommand({
  loader: async () => {
    const { scopeSetAdd } = await import("./scopeSets");
    return scopeSetAdd;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        providerParameter,
        {
          placeholder: "spec",
          brief: "The set as JSON: a file, or an https URL to one (64 KiB at most)",
          parse: String,
        },
      ],
    },
    flags: {
      replace: {
        kind: "boolean",
        brief: "Replace the set of the same name added before",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Add a scope set to a built-in OAuth client, so apps can list it under scopes",
    fullDescription: [
      "The set says its name (identity, or <area>.<access>: gmail.send), its label, its access",
      "(read or write, said outright), the provider's scopes it asks for, and the routes on the",
      "client's own API hosts it unlocks: { host, paths, posts? } (posts are anchored patterns of",
      "the POST paths a read set admits). It is checked by the rules a built-in set is checked",
      "by; a name the client already has, or a host outside the client's, is refused. Live within",
      "30 seconds. The client's authorize scopes grow by the set's: allow them on the OAuth client",
      "at the provider's console, and people connect again to grant them.",
      "",
      "Example:",
      `  ${CLI} provider scope-set add google-workspace gmail-send.json`,
      '  gmail-send.json: { "name": "gmail.send", "label": "Gmail (send)", "access": "write",',
      '    "scopes": ["https://www.googleapis.com/auth/gmail.send"],',
      '    "routes": [{ "host": "gmail.googleapis.com", "paths": ["/gmail/v1/users/"] }] }',
    ].join("\n"),
  },
});

const scopeSetRemoveCommand = buildCommand({
  loader: async () => {
    const { scopeSetRemove } = await import("./scopeSets");
    return scopeSetRemove;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        providerParameter,
        { placeholder: "name", brief: "The set's name, as provider show lists it (added ones marked)", parse: String },
      ],
    },
    flags: {
      force: {
        kind: "boolean",
        brief: "Remove it even though deployed apps list it (their calls under it stop)",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Remove a scope set added to a built-in OAuth client",
    fullDescription: [
      "Only a set added with scope-set add can be removed; the client's own stay. A set a deployed",
      "app lists under scopes is refused unless --force. Connections keep their tokens; calls",
      "under the set answer integration_scopes_undeclared within 30 seconds.",
      "",
      "Example:",
      `  ${CLI} provider scope-set remove google-workspace gmail.send`,
    ].join("\n"),
  },
});

const scopeSetRoutes = buildRouteMap({
  routes: { add: scopeSetAddCommand, remove: scopeSetRemoveCommand },
  aliases: { rm: "remove" },
  docs: {
    brief: "Scope sets an operator adds to the built-in OAuth clients (Google, Microsoft, Slack)",
  },
});

/** `provider on|off`: what `everyapp mcp on|off` was called until 2026-10-24, kept through launch week. */
const mcpAlias = (verb: "on" | "off") =>
  buildCommand({
    loader: async () => {
      const handlers = await import(".");
      return verb === "on" ? handlers.on : handlers.off;
    },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [{ ...idParameter, brief: "The MCP app (mcp list names them): dataforseo" }],
      },
      flags: connectFlags,
    },
    docs: {
      brief: `Same as ${CLI} mcp ${verb}; this alias goes after launch week`,
    },
  });

/**
 * `everyapp provider add|list|show|remove|presets|connections|disconnect`
 * and `provider scope-set add|remove`: the provider registry, the API
 * providers the Gateway brokers (docs/design/2026-10-provider-registry.md),
 * the OAuth providers people connect their accounts to
 * (docs/design/2026-10-oauth-providers.md) and the scope sets an operator
 * adds to the built-in clients.
 * `on` and `off` are hidden: they run `mcp on|off` and say so, for
 * documents that still say `provider on`.
 */
export const providerRoutes = buildRouteMap({
  routes: {
    add: addCommand,
    list: listCommand,
    show: showCommand,
    remove: removeCommand,
    presets: presetsCommand,
    connections: connectionsCommand,
    disconnect: disconnectCommand,
    "scope-set": scopeSetRoutes,
    on: mcpAlias("on"),
    off: mcpAlias("off"),
  },
  aliases: { ls: "list", rm: "remove" },
  docs: {
    brief: "Register API providers for apps to call with the Gateway's key, and OAuth providers people connect their accounts to",
    hideRoute: { on: true, off: true },
  },
});
