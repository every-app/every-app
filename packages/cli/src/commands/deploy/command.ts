import { buildCommand } from "@stricli/core";
import {
  accountFlag,
  forceDnsFlag,
  gatewayFlag,
  jsonFlag,
  verboseFlag,
} from "../flags";

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
        ...forceDnsFlag,
        brief:
          "Publish the app's new hostname even where a DNS record answers it (one at the hostname is replaced)",
      },
      "enable-email-routing": {
        kind: "boolean",
        brief:
          "Turn on Email Routing for the domains email.inbound names that don't route mail yet (locks their MX and SPF records to Cloudflare)",
        optional: true,
      },
      shared: {
        kind: "boolean",
        brief:
          "Deploy a shared app: one Worker every organization's members can open (hosted gateway; platform organization owners and admins)",
        optional: true,
      },
      "no-wait": {
        kind: "boolean",
        brief:
          "Don't wait for the app to go live (a new hostname's certificate included); it goes live on its first visit",
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
      "  1. Registers the app in the Gateway's D1 database, which names its Worker, resources and hostname",
      "     (a new hostname is checked first: no DNS record that answers it, room in the zone)",
      "  2. Creates or links the D1 databases and KV namespaces in everyapp.config.ts",
      "  3. Installs dependencies (the manifest's install setting, or auto-detected)",
      "  4. Builds with cf build (or the manifest's build command): the same tenant-neutral build for",
      "     every install, with placeholders for its Worker name, organization, Gateway, identity key",
      "     and resource ids. Installs it for this deploy (every placeholder rewritten; refused if one",
      "     survives), checks the installed Worker, and checks that the drizzle migrations still",
      "     describe the schema",
      "  5. Bookmarks the production D1 database, then applies its migrations",
      "  6. Uploads it with cf deploy --prebuilt, its secrets in the same version, and",
      "     creates or updates its Workflows (refused if another Worker runs one of their names);",
      "     its helper Workers (everyapp.config.ts workers, <worker>--<name>) go up first; then routes",
      "     the mail to email.inbound's addresses to it with Email Routing rules (checked before",
      "     anything is created; turning routing on for a domain asks first, or --enable-email-routing)",
      "  7. Redeploys the Gateway from this checkout to bind the Worker and publish its hostname (new",
      "     apps; it upgrades the Gateway too when the checkout is newer), then requests the app's",
      "     hostname until it is live (a new hostname's certificate included); behind Cloudflare",
      "     Access, it goes live on its first visit",
      "",
      "No Gateway in any account the login sees? At a terminal it offers to install one at",
      "apps.<zone> (what `everyapp setup` does, owner link included), then deploys; otherwise it",
      "stops with action_required install_gateway and the setup command to run.",
      "Nothing else asks first: the first line says where the app goes. Install and build output",
      "goes to a log file (its last lines and path are shown if it fails), never to stdout.",
      "Safe to run again: a redeploy of an app the Gateway already serves never touches the Gateway.",
      "",
      "--shared (a hosted Gateway only) registers a first-party app every organization's members can",
      "open, owned by the platform organization; its Worker gets no EVERY_APP_ORG_ID. An app keeps the",
      "scope it was registered with: a redeploy without --shared (or a secret set) keeps it shared.",
      "",
      "Hosted gateway, third-party apps: with EVERYAPP_DEPLOY_TOKEN set to a deploy key (Admin → Tokens →",
      "Deploy key; owners and admins), it deploys through the gateway's deploy API instead, with no",
      "Cloudflare login: --gateway <url> or EVERYAPP_GATEWAY_URL names the gateway (required). It",
      "registers the app, builds it tenant-neutral (placeholders the gateway installs), uploads the",
      "Build Output, manifest and migrations, and follows the deploy job (--no-wait: only starts it).",
      "In CI: EVERYAPP_DEPLOY_TOKEN=<deploy key> EVERYAPP_GATEWAY_URL=https://app.everyapp.com pnpm everyapp deploy --json",
    ].join("\n"),
  },
});
