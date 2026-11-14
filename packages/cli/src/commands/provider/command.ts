import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, apiFlags, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

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
      "A preset Composio serves (google-workspace, slack, github-oauth and more) needs no OAuth",
      "client while Composio is on for the organization: people use the accounts in their own",
      "Composio. Then a person at a terminal who linked their own Composio and gave no client is",
      "asked whether to add an OAuth app all the same. Nobody else is asked, and add never turns",
      `Composio on (${CLI} workspace composio on does).`,
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
    brief: "List the accounts people connected to OAuth providers on the Gateway, how each was made, and the apps that use each",
    fullDescription: [
      "A connection is one person's, to one provider: who connected what, the apps they allowed to",
      "use it, how it was made (with the Gateway's OAuth app, or through the person's Composio),",
      "the scopes granted, the status and when it was last used. A connection through Composio",
      "holds services in place of scopes, each with its account there. Never a token.",
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
      "Gateway). A connection made through Composio holds no token: nothing is left to revoke, and",
      "nothing changes at Composio. With --app the connection stays: that app alone loses its",
      "access, until the person allows it again.",
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
      "An OAuth provider with no client reads \"through Composio\" (composio in --json) while the",
      "organization has Composio on and Composio serves it: people use the accounts in their own",
      "Composio, and nothing is left to set.",
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

const noArgs = { kind: "tuple", parameters: [] } as const;

const composioLinkCommand = buildCommand({
  loader: async () => (await import("./composio")).link,
  parameters: { positional: noArgs, flags: apiFlags },
  docs: {
    brief: "Link your Composio: approve a sign-in in the browser, then see what is in it",
    fullDescription: [
      "Composio is a third-party service where you connect your accounts (Gmail, Slack, GitHub).",
      "Where the organization turned it on, an OAuth provider the Gateway has no OAuth app for is",
      "used through the accounts in each person's own Composio. Linking is a sign-in at Composio:",
      "nobody types or pastes a key.",
      "",
      "Starts the sign-in and prints its link, which opens in your browser at a terminal. Under",
      "--json the link is an action_required event (composio_sign_in, data.url, waiting: true) for",
      "the person to open; give it to nobody else, since whoever approves it links their Composio to",
      "your account. The Gateway is asked every 2 seconds until you approve, then what was found in",
      "your Composio is listed: each provider with its services and their accounts. A sign-in that",
      "runs out first (about 10 minutes) is COMPOSIO_LINK_EXPIRED: run it again for a new one.",
      "",
      "Linking adds no connection: an account becomes yours here when an app asks for it and you",
      "say yes, on the Gateway's page. Run again once linked, it lists what is in your Composio",
      "now. While Composio is off for the organization it stops with COMPOSIO_OFF",
      `(${CLI} workspace composio on, an owner's or admin's). Your own link, whatever your role.`,
      "",
      "Examples:",
      `  ${CLI} provider link composio`,
      `  ${CLI} provider link composio --json`,
      "",
      "The Gateway tools: everyapp_provider_composio to read, everyapp_provider_composio_link to start,",
      "everyapp_provider_composio_link_finish to check.",
    ].join("\n"),
  },
});

const composioUnlinkCommand = buildCommand({
  loader: async () => (await import("./composio")).unlink,
  parameters: { positional: noArgs, flags: apiFlags },
  docs: {
    brief: "Unlink your Composio: the connections you made through it are removed",
    fullDescription: [
      "The Gateway deletes the key it held and every connection you made through Composio, with",
      "the access apps had to them, so those apps stop using the accounts at once. A connection",
      "made with the Gateway's own OAuth app stays. Nothing changes at Composio: the accounts stay",
      "connected there, and the key stays valid until you revoke it there.",
      "",
      "Example:",
      `  ${CLI} provider unlink composio`,
      "",
      `The Gateway tool: everyapp_provider_composio_unlink (${CLI} call everyapp_provider_composio_unlink).`,
    ].join("\n"),
  },
});

/**
 * `provider link composio` and `provider unlink composio`: the verb first,
 * as in `provider add google-workspace`. Composio is the one service a
 * person links (docs/design/2026-11-composio.md).
 */
const linkRoutes = buildRouteMap({
  routes: { composio: composioLinkCommand },
  docs: { brief: "Link your Composio, whose accounts serve the OAuth providers the Gateway has no OAuth app for" },
});

const unlinkRoutes = buildRouteMap({
  routes: { composio: composioUnlinkCommand },
  docs: { brief: "Unlink your Composio: the connections you made through it are removed" },
});

/**
 * `everyapp provider add|update|list|show|remove|presets|connections|disconnect|link|unlink`:
 * the provider registry, the API providers the Gateway brokers
 * (docs/design/2026-10-provider-registry.md), the OAuth providers people
 * connect their accounts to (docs/design/2026-11-oauth-one-connection.md),
 * and a person's Composio link (docs/design/2026-11-composio.md): `link
 * composio` and `unlink composio`, each a Gateway tool run as the caller.
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
    link: linkRoutes,
    unlink: unlinkRoutes,
    on: mcpAlias("on"),
    off: mcpAlias("off"),
  },
  aliases: { ls: "list", rm: "remove" },
  docs: {
    brief: "Register API providers for apps to call with the Gateway's key, and OAuth providers people connect their accounts to or use through their Composio",
    hideRoute: { on: true, off: true },
  },
});
