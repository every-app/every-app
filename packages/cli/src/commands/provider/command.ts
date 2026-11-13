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
  brief: "The provider's id (provider list --all names them): stripe",
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
          brief: "A built-in provider's id (openrouter), an OAuth preset's (google-workspace, github-oauth), or a spec: a JSON file or an https URL to one (64 KiB at most)",
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
        brief: "An OAuth provider: a preset (provider presets names them: google-workspace, github-oauth), or a JSON spec file with auth.kind oauth2-user",
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
      "A built-in provider (provider list --all names them) is only its key. An OAuth preset (provider",
      "presets: google-workspace, slack, github-oauth) becomes a registered provider, then takes its",
      "client; deploying an app that lists one registers it too. Any other API is a spec: its id, name,",
      "the page the key comes from (docs), the only hosts the key is ever sent to and how (auth:",
      "bearer, header, query or basic), naming the Gateway setting that holds the key. The spec",
      "never holds the key. A URL is fetched on this machine. The rules a spec must pass: an id",
      "that isn't a built-in provider's, settings named after the id that nothing else reads, and",
      "public hosts that aren't the Gateway's own or its apps'. Run in an app's directory, it also",
      "writes .everyapp/providers/<id>.json for everyapp dev (your key goes in .dev.vars).",
      "",
      "An OpenAI-compatible model provider is a spec with mode \"ai\": its baseUrl, the key's",
      "placement (auth), the models it serves and the defaultModel (embeddingsModel too, when it has",
      "one); the AI proxy serves it as a catalog AI provider, inference POSTs alone. Apps list it",
      "under providers and call /api/ai/<id>/v1/chat/completions; everyapp ai default <id> makes",
      "it the Gateway's default model provider.",
      "",
      "--oauth takes an OAuth spec file (auth.kind oauth2-user), or a preset by name. An app lists",
      "the scopes it needs in everyapp.config.ts, as the provider names them; each person connects",
      "once and allows each app. --verbose adds the manifest entry.",
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
    brief: "List the OAuth presets provider add takes: Google, Microsoft 365, Slack, GitHub and more",
    fullDescription: [
      "Each with its first API host (--json names them all) and the console where its client is",
      "made. An app lists the scopes it needs in everyapp.config.ts, as the provider names them.",
      "Nothing is read from the Gateway.",
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
      app: {
        kind: "parsed",
        parse: String,
        placeholder: "app",
        brief: "The connections one app may use, by its id: openmail",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "List the accounts people connected to OAuth providers on the Gateway, and the apps that use each",
    fullDescription: [
      "A connection is one person's, to one provider: who connected what, the apps they allowed to",
      "use it, the scopes granted, the status and when it was last used. Never a token.",
      "A person may grant fewer scopes than their apps list: that connection is still active, and",
      "its status says how many were granted (\"active, 10 of 18 permissions granted\"; `permissions`",
      "with --json).",
      "",
      "Examples:",
      `  ${CLI} provider connections`,
      `  ${CLI} provider connections --provider github-oauth`,
      `  ${CLI} provider connections --user ben@example.com`,
      `  ${CLI} provider connections --app openmail`,
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
      all: {
        kind: "boolean",
        brief: "Every connection to the provider",
        optional: true,
      },
      app: {
        kind: "parsed",
        parse: String,
        placeholder: "app",
        brief: "Take only this app's access to the connection away and keep the connection, by its id: openmail",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Remove people's connections to an OAuth provider from the Gateway, or one app's access to them",
    fullDescription: [
      "The Gateway drops the tokens it held; every app that used the connection gets \"not",
      "connected\" until the person connects again. The CLI holds no token, so the grant stays at",
      "the provider until it is revoked there (Disconnect in Connected accounts revokes it from the",
      "Gateway). With --app the connection stays: that app alone loses its access, until the person",
      "allows it again.",
      "",
      "Examples:",
      `  ${CLI} provider disconnect github-oauth --user ben@example.com`,
      `  ${CLI} provider disconnect google-workspace --user ben@example.com --app openmail`,
      `  ${CLI} provider disconnect github-oauth --all`,
    ].join("\n"),
  },
});

const listCommand = buildCommand({
  loader: async () => {
    const { list } = await import(".");
    return list;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      all: {
        kind: "boolean",
        brief: "Also list the built-in providers this Gateway doesn't use yet (by default only the ones in use)",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "List the API providers the Gateway uses: each key's state and the apps listing it; --all adds the ones it could",
    fullDescription: [
      "In use: its key or client is set, it was registered here, or an app lists it. The ones an",
      "app is waiting on come first, with the setting to set. --all (or --verbose) adds the rest",
      "of the built-in providers; --json always carries every provider, each with inUse. Hosts,",
      "setting names and who registered a provider are in provider show <id>.",
      "",
      "Nothing is changed. A key's value can't be read back; only whether it is set, and for a",
      "registered provider whether it was set for the hosts it names now (bound).",
      "",
      "Examples:",
      `  ${CLI} provider list`,
      `  ${CLI} provider list --all`,
    ].join("\n"),
  },
});

const updateCommand = buildCommand({
  loader: async () => {
    const { update } = await import(".");
    return update;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: {
      "from-env": {
        kind: "boolean",
        brief: "Read the new key or client from the environment variables of its setting names (GITHUB_API_TOKEN); nothing is asked",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Replace a provider's key or OAuth client on the Gateway, by the provider's id",
    fullDescription: [
      "For a key that was wrong, or rotated at the provider. Asks for the new one at a hidden",
      "prompt and sets it as secret set would. Live at once; no deploy. A provider with several",
      "settings is asked for each: Enter keeps the one that is set. The old value can't be read",
      "back, so it isn't checked.",
      "",
      "Scripts and agents give it with --from-env (the variables of the settings' names) or piped",
      "NAME=value lines; never on the command line. Only the settings given are replaced.",
      "",
      "An OAuth provider's client is replaced the same way (its client id and secret). People's",
      "connections stay; with a different client each person connects again.",
      "",
      "Examples:",
      `  ${CLI} provider update github`,
      `  GITHUB_API_TOKEN=ghp_... ${CLI} provider update github --from-env`,
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
    brief: "Show a provider: whether its key is set, where the key comes from and goes, who registered it and which apps use it",
    fullDescription: [
      "What to read to set up and call a provider that has no setup guide. --json carries its whole",
      "spec (data.provider). With --save, in an app's directory, the spec is written where everyapp",
      "dev reads it.",
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
 * `everyapp provider add|update|list|show|remove|presets|connections|disconnect`:
 * the provider registry, the API providers the Gateway brokers
 * (docs/design/2026-10-provider-registry.md), and the OAuth providers people
 * connect their accounts to (docs/design/2026-11-oauth-one-connection.md).
 * `on` and `off` are hidden: they run `mcp on|off` and say so, for
 * documents that still say `provider on`.
 */
export const providerRoutes = buildRouteMap({
  routes: {
    add: addCommand,
    update: updateCommand,
    list: listCommand,
    show: showCommand,
    remove: removeCommand,
    presets: presetsCommand,
    connections: connectionsCommand,
    disconnect: disconnectCommand,
    on: mcpAlias("on"),
    off: mcpAlias("off"),
  },
  aliases: { ls: "list", rm: "remove" },
  docs: {
    brief: "Register API providers for apps to call with the Gateway's key, and OAuth providers people connect their accounts to",
    hideRoute: { on: true, off: true },
  },
});
