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

/** The flags of a command that acts on the Gateway. */
export interface GatewayCommandFlags {
  gateway?: string;
  "account-id"?: string;
  json?: boolean;
  verbose?: boolean;
}
