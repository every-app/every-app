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
      verbose: {
        kind: "boolean",
        brief: "Show detailed output during deployment",
        optional: true,
      },
      localGateway: {
        kind: "parsed",
        parse: String,
        brief: "Path to local gateway tarball (for testing)",
        optional: true,
      },
      domain: {
        kind: "parsed",
        parse: String,
        brief: "Custom apex domain for the gateway and app subdomains",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Skip deployment confirmation",
        optional: true,
      },
      printSetupLink: {
        kind: "boolean",
        brief:
          "Print the owner setup link even when not run from a terminal (CI logs keep it)",
        optional: true,
      },
    },
    aliases: {
      y: "yes",
    },
  },
  docs: {
    brief: "Deploy the gateway application to Cloudflare",
    fullDescription: [
      "Downloads the gateway release, links Cloudflare resources, reconstructs app service bindings, and deploys to Cloudflare Workers.",
      "The deployment process:",
      "  1. Downloads the gateway release to a temporary directory",
      "  2. Creates or links gateway D1/KV resources",
      "  3. Reconstructs service bindings from the registry",
      "  4. Optionally configures custom-domain routes with --domain",
      "  5. Runs wrangler deploy",
      "  6. Runs database migrations against production D1",
      "  7. Mints a one-time owner setup link if the gateway has no owner yet (in CI or with piped output it only says to run claim-link, unless --printSetupLink)",
      "  8. Cleans up temporary files",
    ].join("\n"),
  },
});

const claimLinkCommand = buildCommand({
  loader: async () => {
    const { claimLink } = await import("./claimLink");
    return claimLink;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [],
    },
    flags: {},
  },
  docs: {
    brief: "Create a new one-time setup link for an unclaimed gateway",
    fullDescription: [
      "Mints a fresh owner setup link (<gateway>/setup#token=...) for a gateway that has no owner yet, using your Cloudflare credentials as proof of control.",
      "Any earlier unused link stops working. Refuses once the gateway has an owner.",
    ].join("\n"),
  },
});

export const gatewayRoutes = buildRouteMap({
  routes: {
    deploy: deployCommand,
    "claim-link": claimLinkCommand,
  },
  docs: {
    brief: "Gateway management commands",
  },
});
