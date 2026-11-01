import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const addCommand = buildCommand({
  loader: async () => {
    const { add } = await import(".");
    return add;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: connectFlags },
  docs: {
    brief: "Give the Gateway its own Cloudflare token, so it installs apps itself",
    fullDescription: [
      "Says what to pick, then opens Cloudflare's page for a new account API token when you press",
      "Enter (No prints its link), its name and every permission the installer uses filled in",
      "(Workers Scripts, D1, Workers KV, R2, Queues, Hyperdrive, Vectorize, AI Gateway, Secrets",
      "Store, Access apps, Email Routing Rules and Zone Settings edit; DNS and Zone read). Create it",
      "and paste it at the hidden prompt: it is stored on the Gateway as CF_DEPLOY_TOKEN, with",
      "BROWSER_APP_INSTALLS=on. Owners and admins then install apps from Admin → Apps → Install app,",
      "or a Deploy to EveryApp button, without running deployment commands.",
      "",
      "A Gateway that has a token keeps it: run again, this only turns installs back on.",
      `To replace the token: ${CLI} deploy-token remove, then add.`,
      "",
      "Examples:",
      `  ${CLI} deploy-token add`,
      `  ${CLI} deploy-token add --gateway https://apps.example.com`,
    ].join("\n"),
  },
});

const removeCommand = buildCommand({
  loader: async () => {
    const { remove } = await import(".");
    return remove;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      yes: { kind: "boolean", optional: true, brief: "Remove the token without asking" },
      ...connectFlags,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Take the Gateway's Cloudflare token off it, so it no longer installs apps itself",
    fullDescription: [
      "Removes CF_DEPLOY_TOKEN and BROWSER_APP_INSTALLS from the Gateway in one change. The apps",
      "it installed keep running. The token works until you delete it in Cloudflare (Manage",
      "account → Account API tokens). Asks first.",
      "",
      "Example:",
      `  ${CLI} deploy-token remove`,
    ].join("\n"),
  },
});

export const deployTokenRoutes = buildRouteMap({
  routes: { add: addCommand, remove: removeCommand },
  docs: {
    brief: "Give the Gateway its own Cloudflare token, so it installs apps itself, or take it off",
  },
});
