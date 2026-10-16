import { buildCommand, buildRouteMap } from "@stricli/core";

export const createCommand = buildCommand({
  loader: async () => import("./create"),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "App ID (kebab-case format)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      deploy: {
        kind: "boolean",
        brief: "Deploy the new app once it is created (see `everyapp app deploy`)",
        optional: true,
      },
      gateway: {
        kind: "parsed",
        parse: String,
        brief:
          "With --deploy: the Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)",
        optional: true,
      },
      "account-id": {
        kind: "parsed",
        parse: String,
        brief:
          "With --deploy: the Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)",
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Print progress as NDJSON events on stdout (never asks anything)",
        optional: true,
      },
      verbose: {
        kind: "boolean",
        brief: "Show detailed output during creation",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Never ask anything (an app id is then required)",
        optional: true,
      },
    },
    aliases: {
      y: "yes",
    },
  },
  docs: {
    brief: "Create a new app from the starter template",
    fullDescription: [
      "Copies the simple-todo starter template into apps/<app-id> inside this checkout, or ./<app-id> anywhere else, and readies it for `everyapp dev`. It doesn't contact your Gateway.",
      "",
      "Usage: everyapp app create <app-id> [--deploy]",
      "",
      "The command will:",
      "  1. Name the app after <app-id> (asked for at a terminal when it's missing)",
      "  2. Install its dependencies",
      "  3. Generate the Worker's types and apply its migrations to the local database",
      "  4. Outside the checkout, start a git repository for it",
      "  5. With --deploy, deploy it as a private Cloudflare Worker (see `everyapp app deploy`)",
      "",
      "Then: cd into it and run `pnpm dev`.",
    ].join("\n"),
  },
});

const gatewayFlag = {
  kind: "parsed",
  parse: String,
  brief:
    "The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)",
  optional: true,
} as const;

const accountFlag = {
  kind: "parsed",
  parse: String,
  brief:
    "The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)",
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
    "Show every step and progress line, and stream build and install output to stderr",
  optional: true,
} as const;

const yesFlag = {
  kind: "boolean",
  brief:
    "Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)",
  optional: true,
} as const;

export const deployCommand = buildCommand({
  loader: async () => {
    const { deploy } = await import("./deploy");
    return deploy;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [],
    },
    flags: {
      gateway: gatewayFlag,
      "account-id": accountFlag,
      verbose: verboseFlag,
      yes: yesFlag,
      json: jsonFlag,
      access: {
        kind: "enum",
        values: ["everyone", "admins"],
        brief:
          "Who can open a newly registered app (overrides the manifest's access; default admins)",
        optional: true,
      },
      "allow-delete-durable-object-data": {
        kind: "boolean",
        brief:
          "Deploy even though Durable Object classes were removed, deleting their data",
        optional: true,
      },
      "allow-delete-workflows": {
        kind: "boolean",
        brief:
          "Deploy even though Workflows were removed, deleting them and their instances",
        optional: true,
      },
      "force-dns": {
        kind: "boolean",
        brief:
          "Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)",
        optional: true,
      },
      "no-wait-cert": {
        kind: "boolean",
        brief:
          "Don't wait for the app to go live (a new hostname's certificate included); it goes live on its first visit",
        optional: true,
      },
    },
    aliases: {
      y: "yes",
    },
  },
  docs: {
    brief: "Deploy an app to Cloudflare",
    fullDescription: [
      "Deploys the current app as a private Cloudflare Worker defined by cloudflare.config.ts, with cf",
      "and your Cloudflare login (or CLOUDFLARE_API_TOKEN), in the Gateway's account:",
      "  1. Registers the app in the Gateway's D1 database, which names its Worker, resources and hostname",
      "     (a new hostname is checked first: no DNS record that answers it, room in the zone)",
      "  2. Creates or links the D1 databases and KV namespaces in everyapp.config.ts",
      "  3. Installs dependencies (the manifest's install setting, or auto-detected)",
      "  4. Bookmarks the production D1 database, then applies its migrations",
      "  5. Builds with cf build (or the manifest's build command) and checks the built Worker",
      "  6. Uploads it with cf deploy --prebuilt, its secrets in the same version, and",
      "     creates or updates its Workflows (refused if another Worker runs one of their names)",
      "  7. Redeploys the Gateway to bind the Worker and publish its hostname (new apps), then",
      "     requests the app's hostname until the Gateway has made it live (a new hostname's",
      "     certificate included); behind Cloudflare Access, it goes live on its first visit",
      "",
      "Nothing asks first: the first line says where the app goes. Install and build output goes to",
      "a log file (its last lines and path are shown if it fails), never to stdout.",
    ].join("\n"),
  },
});

export const deleteCommand = buildCommand({
  loader: async () => {
    const { deleteApp } = await import("./delete");
    return deleteApp;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "App id (default: the app in this directory)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      gateway: gatewayFlag,
      "account-id": accountFlag,
      purge: {
        kind: "boolean",
        brief:
          "Also delete the app's Worker, D1 databases, KV namespaces and Workflows",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief:
          "Delete without asking (with --purge too, without typing the app id)",
        optional: true,
      },
      json: jsonFlag,
      verbose: verboseFlag,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Delete an app from the gateway",
    fullDescription: [
      "Deletes the app in the Gateway's D1 database (its name stays reserved to your organization) and removes its gateway binding.",
      "The app's Worker and data are kept unless --purge, which deletes them for good.",
    ].join("\n"),
  },
});

const d1MigrateCommand = buildCommand({
  loader: async () => {
    const { migrate } = await import("./d1");
    return migrate;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [],
    },
    flags: {
      local: {
        kind: "boolean",
        brief: "Migrate the local database `everyapp dev` uses",
        optional: true,
      },
      json: jsonFlag,
    },
  },
  docs: {
    brief: "Apply D1 migrations to the app's local database",
    fullDescription: [
      "Applies the app's D1 migrations (migrations.dir in everyapp.config.ts, default drizzle/)",
      "to the local database in .cloudflare/state that `cf dev` and `everyapp dev` serve:",
      "",
      "  cf d1 migrations apply <local id> --local --persist-to .cloudflare/state --dir <dir>",
      "",
      "Production migrations run as part of `everyapp app deploy`.",
    ].join("\n"),
  },
});

const d1QueryCommand = buildCommand({
  loader: async () => {
    const { query } = await import("./d1");
    return query;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ brief: "SQL to run", parse: String }],
    },
    flags: {
      local: {
        kind: "boolean",
        brief: "Query the local database `everyapp dev` uses",
        optional: true,
      },
      binding: {
        kind: "parsed",
        parse: String,
        brief: "D1 binding (default: the migrations binding, or the first)",
        optional: true,
      },
      gateway: gatewayFlag,
      "account-id": accountFlag,
      json: {
        kind: "boolean",
        brief: "Print the result as an NDJSON event",
        optional: true,
      },
    },
  },
  docs: {
    brief: "Run SQL against the app's D1 database",
    fullDescription: [
      "Runs SQL against the app's production D1 database through cf, with your Cloudflare login in the gateway's account (or, with --local, against the database in .cloudflare/state).",
      "For anything else, cf works on the database directly: npx cf d1 query <database-id> --sql \"…\"",
    ].join("\n"),
  },
});

const d1Routes = buildRouteMap({
  routes: {
    migrate: d1MigrateCommand,
    query: d1QueryCommand,
  },
  docs: {
    brief: "D1 database commands",
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
      parameters: [{ brief: "The secret's name, e.g. GITHUB_TOKEN", parse: String }],
    },
    flags: {
      "from-env": {
        kind: "parsed",
        parse: String,
        brief: "Read the value from this environment variable instead of a prompt",
        optional: true,
      },
      gateway: gatewayFlag,
      "account-id": accountFlag,
      yes: yesFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Set one of the app's secrets, with a deploy",
    fullDescription: [
      "Sets a secret the app's Worker reads from env (an API key it calls out with, say), from a hidden prompt or --from-env <VAR>, never the command line.",
      "It deploys the app in this directory, code and pending migrations included, with the secret in the same version (see `everyapp app deploy`), and its first line says so. Later deploys keep it.",
      "Names everyapp sets itself are refused: GATEWAY_URL and the EVERYAPP_*, EVERY_APP_* and APP__* names.",
    ].join("\n"),
  },
});

const secretRoutes = buildRouteMap({
  routes: {
    set: secretSetCommand,
  },
  docs: {
    brief: "App secret commands",
  },
});

const workflowArgument = {
  brief: "The Workflow: its binding in everyapp.config.ts, its class or its name",
  parse: String,
  placeholder: "workflow",
};
const instanceArgument = {
  brief: "The instance id",
  parse: String,
  placeholder: "instance-id",
};
const workflowFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: {
    kind: "boolean",
    brief: "Print the result as an NDJSON event",
    optional: true,
  },
} as const;

const workflowsListCommand = buildCommand({
  loader: async () => {
    const { list } = await import("./workflows");
    return list;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: workflowFlags,
  },
  docs: {
    brief: "List the app's Workflows and how many instances each has, by status",
  },
});

const workflowsInstancesCommand = buildCommand({
  loader: async () => {
    const { instances } = await import("./workflows");
    return instances;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [workflowArgument] },
    flags: {
      ...workflowFlags,
      status: {
        kind: "enum",
        values: [
          "queued",
          "running",
          "paused",
          "waiting",
          "waitingForPause",
          "errored",
          "terminated",
          "complete",
          "rollingBack",
        ],
        brief: "Only instances with this status",
        optional: true,
      },
      limit: {
        kind: "parsed",
        parse: (value: string) => {
          const limit = Number(value);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error("--limit must be a whole number from 1 to 100");
          }
          return limit;
        },
        brief: "How many to list (1-100, default 25)",
        optional: true,
      },
    },
  },
  docs: { brief: "List a Workflow's instances" },
});

const workflowsGetCommand = buildCommand({
  loader: async () => {
    const { get } = await import("./workflows");
    return get;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [workflowArgument, instanceArgument],
    },
    flags: workflowFlags,
  },
  docs: {
    brief: "Show an instance: its status, params, steps, output and error",
  },
});

const workflowsStartCommand = buildCommand({
  loader: async () => {
    const { start } = await import("./workflows");
    return start;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [workflowArgument] },
    flags: {
      ...workflowFlags,
      params: {
        kind: "parsed",
        parse: String,
        brief: "The instance's params, as JSON",
        optional: true,
      },
      id: {
        kind: "parsed",
        parse: String,
        brief: "The instance id (default: one Cloudflare picks)",
        optional: true,
      },
    },
  },
  docs: { brief: "Start an instance of a Workflow" },
});

function workflowsStatusCommand(
  status: "pause" | "resume" | "restart",
  brief: string,
) {
  return buildCommand({
    loader: async () => (await import("./workflows"))[status],
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [workflowArgument, instanceArgument],
      },
      flags: workflowFlags,
    },
    docs: { brief },
  });
}

const workflowsTerminateCommand = buildCommand({
  loader: async () => {
    const { terminate } = await import("./workflows");
    return terminate;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [workflowArgument, instanceArgument],
    },
    flags: {
      ...workflowFlags,
      yes: { kind: "boolean", brief: "Skip the confirmation", optional: true },
    },
    aliases: { y: "yes" },
  },
  docs: { brief: "Stop an instance for good (asks first)" },
});

const workflowsRoutes = buildRouteMap({
  routes: {
    list: workflowsListCommand,
    instances: workflowsInstancesCommand,
    get: workflowsGetCommand,
    start: workflowsStartCommand,
    pause: workflowsStatusCommand("pause", "Pause an instance"),
    resume: workflowsStatusCommand("resume", "Resume a paused instance"),
    terminate: workflowsTerminateCommand,
    restart: workflowsStatusCommand(
      "restart",
      "Run an instance again from the start",
    ),
  },
  docs: {
    brief: "The deployed app's Workflows, through cf in the gateway's account",
  },
});

export const appRoutes = buildRouteMap({
  routes: {
    create: createCommand,
    deploy: deployCommand,
    secret: secretRoutes,
    d1: d1Routes,
    workflows: workflowsRoutes,
    delete: deleteCommand,
  },
  docs: {
    brief: "App management commands",
  },
});
