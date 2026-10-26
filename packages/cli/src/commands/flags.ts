/** The flags several commands take, said the same way everywhere. */

export const gatewayFlag = {
  kind: "parsed",
  parse: String,
  brief:
    "The Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)",
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
 * `--org` on a Gateway command that acts on one organization (`workspace`,
 * `events`): resolved by lib/gateway/workspace.ts `resolveOrganization`.
 */
export const orgFlag = {
  kind: "parsed",
  parse: String,
  brief:
    "The organization to act on, by slug, id or name (default: the install organization; a name two organizations share is refused, ORG_AMBIGUOUS: give the slug)",
  placeholder: "slug",
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
    "Show every step and progress line, the output of what everyapp runs, and an unexpected error's stack trace",
  optional: true,
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

/** The flags of a Gateway command that acts on one organization: the Gateway's, and `--org`. */
export interface OrganizationCommandFlags extends GatewayCommandFlags {
  /** `--org`: the organization by slug, id or name; the install organization without it. */
  org?: string;
}

/** `deploy`'s and `install`'s flags: the Gateway's, the takeovers, and the two of their own. */
export interface AppDeployFlags extends GatewayCommandFlags {
  yes?: boolean;
  "allow-delete-durable-object-data"?: boolean;
  "allow-delete-workflows"?: boolean;
  "force-dns"?: boolean;
  "enable-email-routing"?: boolean;
  "register-providers"?: boolean;
  "no-wait"?: boolean;
}
