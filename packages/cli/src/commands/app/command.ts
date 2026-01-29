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
      verbose: {
        kind: "boolean",
        brief: "Show detailed output during creation",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Skip deployment confirmation",
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
      "Copies the simple-todo starter template, deploys to Cloudflare, and configures local development.",
      "",
      "Usage: every app create [name]",
      "",
      "The command will:",
      "  1. Prompt for app ID (or use provided name)",
      "  2. Deploy to Cloudflare (D1 database, KV namespace, Worker)",
      "  3. Configure wrangler.jsonc, package.json, and .env files",
      "  4. Install dependencies and run local migrations",
      "",
      "After creation, run 'pnpm run dev' to start developing.",
    ].join("\n"),
  },
});

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
      verbose: {
        kind: "boolean",
        brief: "Show detailed output during deployment",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Skip deployment confirmation",
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
      "Deploys the current app to Cloudflare Workers from the current directory.",
      "The deployment process:",
      "  1. Reads wrangler.jsonc to determine required resources",
      "  2. Creates or links D1 databases and KV namespaces",
      "  3. Updates wrangler.jsonc with resource IDs",
      "  4. Installs dependencies if needed",
      "  5. Runs database migrations against production D1",
      "  6. Builds and deploys using wrangler deploy",
    ].join("\n"),
  },
});

export const remoteD1ShellCommand = buildCommand({
  loader: async () => {
    const { remoteD1Shell } = await import("./remoteD1Shell");
    return remoteD1Shell;
  },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Command and arguments to run with environment variables",
        parse: String,
      },
    },
  },
  docs: {
    brief: "Run a command with Cloudflare D1 connection environment variables",
    fullDescription: [
      "Sets environment variables needed to connect to remote Cloudflare D1 and runs any command that requires D1 access.",
      "",
      "The command will:",
      "  1. Get the Cloudflare account ID",
      "  2. Look up the database ID from the database name in wrangler.jsonc",
      "  3. Get a valid OAuth token",
      "  4. Run the provided command with CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, CLOUDFLARE_API_TOKEN, and MIGRATE_REMOTE set",
      "",
      "Common use cases:",
      "  - Running Drizzle migrations: npx everyapp app remote-d1-shell -- npx drizzle-kit migrate",
      "  - Opening Drizzle Studio: npx everyapp app remote-d1-shell -- npx drizzle-kit studio",
      "  - Pushing schema changes: npx everyapp app remote-d1-shell -- npx drizzle-kit push",
      "",
      "This command is useful for any operation that needs direct access to your production D1 database.",
    ].join("\n"),
  },
});

export const appRoutes = buildRouteMap({
  routes: {
    create: createCommand,
    deploy: deployCommand,
    "remote-d1-shell": remoteD1ShellCommand,
  },
  docs: {
    brief: "App management commands",
  },
});
