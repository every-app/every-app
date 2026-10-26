import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, appTakeoverFlags, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

export const deployCommand = buildCommand({
  loader: async () => {
    const { deploy } = await import(".");
    return deploy;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      gateway: gatewayFlag,
      "account-id": accountFlag,
      ...appTakeoverFlags,
      "no-wait": {
        kind: "boolean",
        brief:
          "Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief:
          "With no Gateway yet, install one at apps.<zone> without asking (never cf's questions, or the one before replacing a Worker changed outside everyapp)",
        optional: true,
      },
      json: jsonFlag,
      verbose: verboseFlag,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Deploy the app in this directory",
    fullDescription: [
      "Deploys the app in this directory as a private Cloudflare Worker defined by cloudflare.config.ts,",
      "with cf and your Cloudflare login (or CLOUDFLARE_API_TOKEN), in the Gateway's account:",
      "  1. Registers the app in the Gateway's database, which names its Worker, resources and hostname",
      "  2. Creates or links the D1 databases and KV namespaces in everyapp.config.ts",
      "  3. Installs dependencies and builds (cf build, or the manifest's build command), then checks",
      "     the built Worker against the app policy and the drizzle migrations against the schema",
      "  4. Bookmarks the production D1 database, then applies its migrations",
      "  5. Uploads the Worker with its secrets, its helper Workers, its Workflows and the Email",
      "     Routing rules for its inbound addresses (turning routing on for a domain asks first)",
      "  6. Rebinds the Gateway from this checkout when the app is new (upgrading the Gateway too",
      "     when the checkout is newer), then waits for the app's hostname to go live",
      "",
      "No Gateway in any account the login sees, and none named? At a terminal it offers to install one at",
      `apps.<zone> (what ${CLI} setup does), then deploys; otherwise it stops with action_required`,
      "install_gateway and the setup command to run. Nothing else asks first. Install and build",
      "output goes to a log file, never to stdout. Safe to run again: a redeploy of an app the",
      "Gateway already serves never touches the Gateway.",
      "",
      `Someone else's published app: ${CLI} install <url>. To publish this one: ${CLI} release.`,
      "--gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway when your login sees several.",
      "With --json, each step is an NDJSON event.",
    ].join("\n"),
  },
});
