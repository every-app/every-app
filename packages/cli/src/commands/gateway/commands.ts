import { buildCommand, buildRouteMap } from "@stricli/core";

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
      repo: {
        kind: "parsed",
        parse: String,
        brief: "Git repository URL to deploy",
        optional: true,
      },
      verbose: {
        kind: "boolean",
        brief: "Show detailed output during deployment",
        optional: true,
      },
    },
  },
  docs: {
    brief: "Deploy the gateway application to Cloudflare",
    fullDescription: [
      "Clones the gateway repository, installs dependencies, runs migrations, and deploys to Cloudflare Workers.",
      "The deployment process:",
      "  1. Clones the repository to a temporary directory",
      "  2. Installs npm dependencies",
      "  3. Runs database migrations against production D1",
      "  4. Runs wrangler deploy",
      "  5. Cleans up temporary files",
    ].join("\n"),
  },
});

export const gatewayRoutes = buildRouteMap({
  routes: {
    deploy: deployCommand,
  },
  docs: {
    brief: "Gateway management commands",
  },
});
