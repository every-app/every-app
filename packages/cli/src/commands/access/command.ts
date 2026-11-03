import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const onCommand = buildCommand({
  loader: async () => {
    const { on } = await import(".");
    return on;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      team: {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "name",
        brief:
          "Name for a new Zero Trust team when the account has none: its sign-in page is <name>.cloudflareaccess.com, for good (asked at a terminal; ignored once a team exists)",
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Turn Cloudflare Access on in front of the Gateway and its apps, or bring it up to date",
    fullDescription: [
      "Everyone opens the Gateway and its apps through Cloudflare Access first (Sign in with",
      "Cloudflare for members of your Cloudflare account, a one-time PIN emailed to everyone else),",
      "then lands signed in. With your Cloudflare login it finds or creates the Zero Trust team,",
      "adds those two sign-in methods, keeps one allow policy whose rule asks the Gateway whether",
      "the person is a member or invited, puts one Access application in front of the Gateway's",
      "host and one in front of the apps' hosts (MCP, the OAuth endpoints and each app's public",
      "routes stay reachable without a login), and gives the Gateway the team domain and both AUD",
      "tags in one change.",
      "",
      "Invitations need nothing more: an invitee gets past Access as soon as they are invited.",
      "Run it again after deploying an app with new public routes, or after anything changed by",
      "hand. It changes only what differs and leaves alone what it didn't set up.",
      "",
      "Examples:",
      `  ${CLI} access on`,
      `  ${CLI} access on --team acme --json`,
    ].join("\n"),
  },
});

const offCommand = buildCommand({
  loader: async () => {
    const { off } = await import(".");
    return off;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      yes: { kind: "boolean", optional: true, brief: "Turn Access off without asking" },
      ...connectFlags,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Turn Cloudflare Access off for the Gateway and its apps",
    fullDescription: [
      "Removes CLOUDFLARE_ACCESS_AUD, CLOUDFLARE_ACCESS_APPS_AUD and CLOUDFLARE_ACCESS_TEAM_DOMAIN",
      "from the Gateway in one change, so it stops requiring Access at once, then deletes the",
      "two Access applications (one that also covers something else only loses EveryApp's hosts).",
      "The Zero Trust team, its identity providers and the allow policy stay: other applications may",
      "use them. Asks first.",
      "",
      "Example:",
      `  ${CLI} access off`,
    ].join("\n"),
  },
});

const showCommand = buildCommand({
  loader: async () => {
    const { show } = await import(".");
    return show;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: connectFlags },
  docs: {
    brief: "Show how Cloudflare Access fronts the Gateway",
    fullDescription: [
      "The Zero Trust team, whether the allow policy asks the Gateway who is a member, the sign-in",
      "methods, the two Access applications, and which Access settings the Gateway has (their",
      "values can't be read back). Nothing is changed.",
      "",
      "Example:",
      `  ${CLI} access show`,
    ].join("\n"),
  },
});

export const accessRoutes = buildRouteMap({
  routes: { on: onCommand, off: offCommand, show: showCommand },
  docs: {
    brief: "Put Cloudflare Access in front of the Gateway and its apps, or take it off",
  },
});
