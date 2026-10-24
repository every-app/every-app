import { buildCommand, buildRouteMap } from "@stricli/core";
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
      email: {
        kind: "parsed",
        parse: String,
        variadic: true,
        optional: true,
        placeholder: "address",
        brief: "Also let this email address past Access (repeat for several; an account still takes an invitation)",
      },
      "email-domain": {
        kind: "parsed",
        parse: String,
        variadic: true,
        optional: true,
        placeholder: "domain",
        brief: "Also let everyone with an email address at this domain past Access (repeat for several)",
      },
      team: {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "name",
        brief:
          "Name for a new Zero Trust team when the account has none: its sign-in page is <name>.cloudflareaccess.com, for good (asked at a terminal; ignored once a team exists)",
      },
      session: {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "duration",
        brief:
          "How long an Access sign-in lasts, like 720h or 24h (default 720h, the most Access allows; an existing application keeps its own unless given)",
      },
      "team-session": {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "duration",
        brief:
          "Set the team's global session too (how often people sign in at the identity provider): it applies to every Access application in the account",
      },
      "write-settings": {
        kind: "boolean",
        optional: true,
        brief:
          "Write the three Gateway settings even when they are set already (after an Access application was recreated by hand: its AUD tag changed)",
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Turn Cloudflare Access on in front of the Gateway and its apps, or bring it up to date",
    fullDescription: [
      "Everyone opens the Gateway and its apps through Cloudflare Access first (a one-time PIN to",
      "their email, or your identity provider), then lands signed in. With your Cloudflare login it",
      "finds or creates the Zero Trust team, adds the one-time PIN when people have no other way to",
      "sign in, keeps an allow policy with every member's and invitee's email, puts one Access",
      "application in front of the Gateway's host and one in front of the apps' hosts (MCP, the OAuth",
      "endpoints and each app's public routes stay reachable without a login), and gives the Gateway",
      "the team domain and both AUD tags in one change.",
      "",
      "Run it again any time: after inviting someone, so Access lets them in, or after anything",
      "changed by hand. It changes only what differs, never removes anyone from the policy, and",
      "leaves alone what it didn't set up. Deploys keep an app's public routes in step themselves.",
      "",
      "Afterwards each existing member signs in once with their password through Access, which",
      "links the two. Then passwords can go: everyapp secret set EMAIL_PASSWORD_SIGN_IN (false).",
      "",
      "Examples:",
      "  everyapp access on",
      "  everyapp access on --email-domain example.com",
      "  everyapp access on --team acme --json",
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
      "keep-applications": {
        kind: "boolean",
        optional: true,
        brief:
          "Keep the two Access applications: Access still asks people to sign in there, and the Gateway no longer requires it",
      },
      yes: { kind: "boolean", optional: true, brief: "Turn Access off without asking" },
      ...connectFlags,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Turn Cloudflare Access off for the Gateway and its apps",
    fullDescription: [
      "Removes CLOUDFLARE_ACCESS_AUD, CLOUDFLARE_ACCESS_APPS_AUD and CLOUDFLARE_ACCESS_TEAM_DOMAIN",
      "from the Gateway in one change, so passwords sign people in again at once, then deletes the",
      "two Access applications (one that also covers something else only loses Every App's hosts).",
      "The Zero Trust team, its identity providers and the allow policy stay: other applications may",
      "use them. Asks first.",
      "",
      "Example:",
      "  everyapp access off",
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
    brief: "Show how Cloudflare Access fronts the Gateway, and what access on would change",
    fullDescription: [
      "The Zero Trust team, who the allow policy lets in, the two Access applications and whether",
      "their public paths match the apps' public routes, and which Access settings the Gateway has",
      "(their values can't be read back). Nothing is changed.",
      "",
      "Example:",
      "  everyapp access show",
    ].join("\n"),
  },
});

export const accessRoutes = buildRouteMap({
  routes: { on: onCommand, off: offCommand, show: showCommand },
  docs: {
    brief: "Put Cloudflare Access in front of the Gateway and its apps, or take it off",
  },
});
