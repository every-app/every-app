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

export const jsonFlag = {
  kind: "boolean",
  brief:
    "Print only NDJSON events on stdout (exit 2: an action is required; then run it again)",
  optional: true,
} as const;

/** For commands that only read: their result is the `done` event. */
export const resultJsonFlag = {
  kind: "boolean",
  brief: "Print the result as an NDJSON event",
  optional: true,
} as const;

export const verboseFlag = {
  kind: "boolean",
  brief:
    "Show every step and progress line, and stream build and install output to stderr",
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
