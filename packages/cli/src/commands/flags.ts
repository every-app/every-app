/** The flags several commands take, said the same way everywhere. */

export const gatewayFlag = {
  kind: "parsed",
  parse: String,
  brief:
    "The Gateway's URL, or its name when the account holds several (every-app-gateway-<name>, or <name>; every-app-gateway is the first one), checked against the Gateways in your Cloudflare account (default: EVERYAPP_GATEWAY_URL; one Gateway in all your accounts needs neither)",
  optional: true,
} as const;

export const accountFlag = {
  kind: "parsed",
  parse: String,
  brief:
    "The Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)",
  optional: true,
} as const;

/**
 * `--gateway` on a command that calls the Gateway's admin API
 * (lib/gatewayApi): its URL, or its name among the Gateways the Cloudflare
 * login finds.
 */
const apiGatewayFlag = {
  kind: "parsed",
  parse: String,
  brief:
    "The Gateway's URL (default: EVERYAPP_GATEWAY_URL, else the Gateway you signed in to with login --gateway, else the one your Cloudflare login finds; a name picks among several there)",
  optional: true,
} as const;

/** The same on every command: the event stream and its exit codes (lib/output/events.ts). */
export const jsonFlag = {
  kind: "boolean",
  brief:
    "Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)",
  optional: true,
} as const;

/** For a command whose result is the event (db query): its rows as NDJSON. */
export const resultJsonFlag = {
  kind: "boolean",
  brief: "Print the result as an NDJSON event",
  optional: true,
} as const;

export const verboseFlag = {
  kind: "boolean",
  brief:
    "Show every step and progress line, the detail a result's short form leaves out, the output of what everyapp runs, and an unexpected error's stack trace",
  optional: true,
} as const;

/**
 * Every command that is one Gateway tool (lib/gatewayApi): which Gateway,
 * and how to print. The credential is EVERYAPP_TOKEN or the browser
 * sign-in, never a flag.
 */
export const apiFlags = {
  gateway: apiGatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

export const yesFlag = {
  kind: "boolean",
  brief:
    "Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)",
  optional: true,
} as const;

export const forceDnsFlag = {
  kind: "boolean",
  brief:
    "Publish new hostnames even where a DNS record answers them (one at a hostname is replaced)",
  optional: true,
} as const;

/**
 * What a deploy of an app may take over, with the person's yes: `deploy`
 * and `install` declare all five, and each refusal's `rerun` adds the one
 * it needs (TAKEOVER_FLAGS in lib/errors.ts).
 */
export const appTakeoverFlags = {
  "allow-delete-durable-object-data": {
    kind: "boolean",
    brief: "Deploy even though Durable Object classes were removed, deleting their data",
    optional: true,
  },
  "allow-delete-workflows": {
    kind: "boolean",
    brief: "Deploy even though Workflows were removed, deleting them and their instances",
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
      "Turn on Email Routing for the domains the app's inbound addresses (everyapp email set --inbound) name that don't route mail yet (locks their MX and SPF records to Cloudflare)",
    optional: true,
  },
  "replace-mx": {
    kind: "boolean",
    brief:
      "Turn on Email Routing even for a domain whose MX records deliver its mail elsewhere (Google Workspace...): they are replaced, and that mail stops arriving there",
    optional: true,
  },
  "register-providers": {
    kind: "boolean",
    brief:
      "Register the providers the app bundles, which tell the Gateway where to send their keys (--yes doesn't)",
    optional: true,
  },
} as const;

/** The flags of a command that acts on the Gateway. */
export interface GatewayCommandFlags {
  gateway?: string;
  "account-id"?: string;
  json?: boolean;
  verbose?: boolean;
}

/** `deploy`'s and `install`'s flags: the Gateway's, the takeovers, and the two of their own. */
export interface AppDeployFlags extends GatewayCommandFlags {
  yes?: boolean;
  "allow-delete-durable-object-data"?: boolean;
  "allow-delete-workflows"?: boolean;
  "force-dns"?: boolean;
  "enable-email-routing"?: boolean;
  "replace-mx"?: boolean;
  "register-providers"?: boolean;
  "no-wait"?: boolean;
}
