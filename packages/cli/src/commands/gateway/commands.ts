import { buildCommand, buildRouteMap } from "@stricli/core";

const accountFlag = {
  kind: "parsed",
  parse: String,
  brief:
    "Cloudflare account id (default: CLOUDFLARE_ACCOUNT_ID, the account used before, or the only one)",
  optional: true,
} as const;
const jsonFlag = {
  kind: "boolean",
  brief:
    "Print only NDJSON events on stdout (exit 2: an action is required; then run it again)",
  optional: true,
} as const;
const verboseFlag = {
  kind: "boolean",
  brief:
    "Show every step and progress line, and stream build output to stderr",
  optional: true,
} as const;
const yesFlag = {
  kind: "boolean",
  brief: "Skip confirmation prompts",
  optional: true,
} as const;
const forceDnsFlag = {
  kind: "boolean",
  brief:
    "Publish new hostnames even where a DNS record answers them (one at a hostname is replaced)",
  optional: true,
} as const;

const deployFlags = {
  domain: {
    kind: "parsed",
    parse: String,
    brief:
      "Hostname the gateway serves at, in a zone the account has, e.g. apps.example.com (remembered after the first deploy)",
    optional: true,
  },
  "account-id": accountFlag,
  release: {
    kind: "parsed",
    parse: String,
    brief: "Deploy this gateway release tarball instead of building one from this checkout",
    optional: true,
  },
  yes: {
    kind: "boolean",
    brief:
      "Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)",
    optional: true,
  },
  printSetupLink: {
    kind: "boolean",
    brief:
      "Print the owner setup link even when not run from a terminal (CI logs keep it)",
    optional: true,
  },
  "allow-downgrade": {
    kind: "boolean",
    brief: "Deploy a release older than the one the gateway runs",
    optional: true,
  },
  "force-dns": forceDnsFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

export const deployCommand = buildCommand({
  loader: async () => {
    const { deploy } = await import("./deploy");
    return deploy;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: deployFlags,
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Deploy the gateway to Cloudflare",
    fullDescription: [
      "Builds the gateway release from this checkout (apps/every-app-gateway), then deploys its Build Output with cf:",
      "  1. Finds or creates the gateway's D1 database and KV namespaces",
      "  2. Takes the deploy lease, so deploys never overlap",
      "  3. Checks every new hostname: no DNS record that answers it (unless --force-dns),",
      "     room in the zone",
      "  4. Bookmarks the database, then applies migrations before any code changes",
      "  5. Binds every registered app, publishes the gateway's domain and each app's as",
      "     Workers Custom Domains, then uploads with cf deploy",
      "     (a first deploy sends the generated secrets with the upload)",
      "  6. Waits for the new version to serve and records the install, then for new certificates",
      "  7. Mints a one-time owner setup link if the gateway has no owner yet",
      "     (in CI or with piped output it only says to run claim-link, unless --printSetupLink)",
      "",
      "The gateway serves at --domain, any hostname in a zone the account has (apps.example.com in",
      "example.com), and apps one label below it: todo.apps.example.com. Cloudflare creates their",
      "DNS records and certificates; nothing else in the zone changes. `everyapp setup` does all of",
      "this, and the owner login, in one command.",
    ].join("\n"),
  },
});

const upgradeCommand = buildCommand({
  loader: async () => {
    const { upgrade } = await import("./upgrade");
    return upgrade;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: deployFlags,
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Upgrade the gateway to a release built from this checkout",
    fullDescription:
      "Like `gateway deploy` for a gateway this CLI deployed before, with its remembered domain and account. Does nothing when the gateway already runs the release this checkout builds, and refuses an older one without --allow-downgrade.",
  },
});

const reconcileCommand = buildCommand({
  loader: async () => {
    const { reconcile } = await import("./reconcile");
    return reconcile;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      "account-id": accountFlag,
      "dry-run": {
        kind: "boolean",
        brief: "Show the bindings and cf's check without deploying",
        optional: true,
      },
      force: {
        kind: "boolean",
        brief: "Redeploy even when the live bindings already match",
        optional: true,
      },
      "force-dns": forceDnsFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Bind and publish exactly the apps the gateway's registry lists",
    fullDescription:
      "Redeploys the release the gateway runs (from the account's release cache, checked against its SHA-256) with a service binding for every uploaded app, and each app's hostname as a Workers Custom Domain. Never upgrades or downgrades the gateway. `app deploy` and `app delete` run it when the set of apps changes.",
  },
});

const statusCommand = buildCommand({
  loader: async () => {
    const { status } = await import("./status");
    return status;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      "account-id": accountFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Show the gateway's release, bindings, owner and certificate",
  },
});

const claimLinkCommand = buildCommand({
  loader: async () => {
    const { claimLink } = await import("./claimLink");
    return claimLink;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      "account-id": accountFlag,
      domain: {
        kind: "parsed",
        parse: String,
        brief: "The gateway's domain, for a gateway deployed before install records",
        optional: true,
      },
    },
  },
  docs: {
    brief: "Create a new one-time setup link for an unclaimed gateway",
    fullDescription: [
      "Mints a fresh owner setup link (<gateway>/setup#token=...) for a gateway that has no owner yet, using your Cloudflare credentials as proof of control.",
      "Any earlier unused link stops working. Refuses once the gateway has an owner.",
    ].join("\n"),
  },
});

const secretSetCommand = buildCommand({
  loader: async () => {
    const { set } = await import("./secret");
    return set;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief:
            "The setting, e.g. OPENAI_API_KEY, MCP_OAUTH_ENABLED or CLOUDFLARE_ACCESS_AUD (any other name lists them all)",
          parse: String,
        },
      ],
    },
    flags: {
      "from-env": {
        kind: "parsed",
        parse: String,
        brief: "Read the value from this environment variable instead of a prompt",
        optional: true,
      },
      "account-id": accountFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Set one of the gateway's optional settings",
    fullDescription:
      "Sends the value with a redeploy of the live gateway release (cf deploy --secrets-file), never on the command line.",
  },
});

export const gatewayRoutes = buildRouteMap({
  routes: {
    deploy: deployCommand,
    upgrade: upgradeCommand,
    reconcile: reconcileCommand,
    status: statusCommand,
    "claim-link": claimLinkCommand,
    secret: buildRouteMap({
      routes: { set: secretSetCommand },
      docs: { brief: "Gateway settings" },
    }),
  },
  docs: {
    brief: "Gateway management commands",
  },
});
