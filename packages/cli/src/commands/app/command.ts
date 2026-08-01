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
      "  2. Deploy a private Cloudflare Worker from everyapp.config.ts",
      "  3. Configure package.json and local .env files",
      "  4. Install dependencies and run local migrations for the starter app",
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
      "skip-dns-check": {
        kind: "boolean",
        brief: "Skip app subdomain DNS preflight check",
        optional: true,
      },
      domain: {
        kind: "parsed",
        parse: String,
        brief: "Not for this command; configure the gateway domain instead",
        optional: true,
        hidden: true,
      },
    },
    aliases: {
      y: "yes",
    },
  },
  docs: {
    brief: "Deploy an app to Cloudflare",
    fullDescription: [
      "Deploys the current app as a private Cloudflare Worker from everyapp.config.ts.",
      "The deployment process:",
      "  1. Loads and validates everyapp.config.ts",
      "  2. Verifies the app subdomain can resolve through Cloudflare DNS",
      "  3. Creates or links declared D1 databases and KV namespaces",
      "  4. Generates .everyapp/wrangler.json",
      "  5. Installs dependencies using the manifest install setting or package-manager auto-detection",
      "  6. Runs the configured database migration strategy against production D1",
      "  7. Runs the configured build, deploys, registers with the gateway, and ensures the service binding",
    ].join("\n"),
  },
});

export const generateConfigCommand = buildCommand({
  loader: async () => {
    const { generateConfig } = await import("./generateConfig");
    return generateConfig;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [],
    },
    flags: {
      verbose: {
        kind: "boolean",
        brief: "Show generated config details",
        optional: true,
      },
    },
  },
  docs: {
    brief: "Generate .everyapp/wrangler.json from everyapp.config.ts",
    fullDescription: [
      "Loads everyapp.config.ts, validates it, and writes the generated Wrangler config consumed by Vite and Wrangler.",
      "",
      "Run this before invoking vite directly.",
    ].join("\n"),
  },
});

export const setupLocalCommand = buildCommand({
  loader: async () => {
    const { setupLocal } = await import("./setupLocal");
    return setupLocal;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [],
    },
    flags: {
      verbose: {
        kind: "boolean",
        brief: "Show detailed output during local setup",
        optional: true,
      },
    },
  },
  docs: {
    brief: "Set up local development in an existing app",
    fullDescription: [
      "Configures local development for an existing Every App project in the current directory.",
      "",
      "Usage: every app setup-local",
      "",
      "The command will:",
      "  1. Verify the current directory is an Every App project",
      "  2. Verify Cloudflare and gateway setup",
      "  3. Install dependencies using package-manager auto-detection",
      "  4. Create or refresh .env.local",
      "  5. Run local setup scripts for template-style apps",
      "",
      "This is useful after cloning an existing Every App repository.",
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
      "  2. Look up the database ID from the generated Wrangler database name",
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
    "generate-config": generateConfigCommand,
    "setup-local": setupLocalCommand,
    "remote-d1-shell": remoteD1ShellCommand,
  },
  docs: {
    brief: "App management commands",
  },
});
