import { buildCommand } from "@stricli/core";
import { jsonFlag, verboseFlag } from "../flags";

export const teardownCommand = buildCommand({
  loader: async () => {
    const { teardown } = await import(".");
    return teardown;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      "account-id": {
        kind: "parsed",
        parse: String,
        placeholder: "id",
        brief:
          "The account to empty (required; 32 hex characters, from the dashboard URL dash.cloudflare.com/<id>/…; never read from CLOUDFLARE_ACCOUNT_ID): a dedicated test account, unless --gateway names a named Gateway",
      },
      gateway: {
        kind: "parsed",
        parse: String,
        placeholder: "name",
        optional: true,
        brief:
          "Tear down only this named Gateway and its apps (its name, or its Worker's every-app-gateway-<name>); without it, the default Gateway",
      },
      all: {
        kind: "boolean",
        optional: true,
        brief: "Tear down every Gateway in the account, the named ones first and the default last (a dedicated test account; not with --gateway)",
      },
      confirm: {
        kind: "parsed",
        parse: String,
        placeholder: "id",
        optional: true,
        brief:
          "The same account id again (with --gateway <name>: every-app-gateway-<name>), for a run without a terminal (--json, a script); at a terminal it is typed instead",
      },
      "dry-run": {
        kind: "boolean",
        optional: true,
        brief: "List what would be deleted and stop; nothing is written",
      },
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Delete everything EveryApp created in a dedicated test Cloudflare account, or one named Gateway",
    fullDescription: [
      "For the accounts the onboarding loop installs into, over and over: removes every Worker,",
      "Workflow, D1 database, KV namespace, R2 bucket, Hyperdrive config, queue, Vectorize index,",
      "AI Gateway and Secrets Store secret of the default Gateway's names (every-*, but never",
      "another Gateway's: every-app-gateway-<name>... or every-<name>--...), the Gateway's own",
      "included, the two Cloudflare Access applications and the allow policy, the Email Routing",
      "rules that send mail to those Workers (a catch-all drops mail again, and routing is turned",
      "off once no rule and no catch-all of anyone else's needs it), the certificate packs of the",
      "hostnames the Gateway published, and the Custom Domain records (A, AAAA, CNAME) left at",
      "exactly those names. Never the zone, the Workers Paid subscription, the workers.dev",
      "subdomain, the Zero Trust team and its identity providers, a Secrets Store itself, any other",
      "DNS record (MX, TXT, CAA...) even at those names, R2 buckets outside the default",
      "jurisdiction, or anything whose name isn't the Gateway's and that no app recorded.",
      "",
      "Without --gateway it is destructive and exists for dedicated test accounts only. The",
      "account must be on the allowlist (EVERYAPP_TEST_ACCOUNTS, or one id per line in",
      "~/.config/everyapp/test-accounts), the run needs CLOUDFLARE_API_TOKEN scoped to that account",
      "alone (a token that sees any other account is refused), and an account on the forbidden",
      "list (EVERYAPP_FORBIDDEN_ACCOUNTS, or one id per line in ~/.config/everyapp/forbidden-accounts)",
      "is refused first, whatever the allowlist says. It reads everything first and shows what it",
      "found; then the account id is typed at the terminal, or passed again with --confirm for a",
      "run without one. There is no --yes.",
      "",
      "One account may hold several Gateways. --gateway <name> tears down only that named",
      "Gateway: every-app-gateway-<name> with its OAuth KV and activation queue, its apps",
      "every-<name>--* and their resources, its AI Gateways every-app-gateway-<name>-*, and its",
      "Access applications and policy (\"Every App gateway (<name>)\" and the like). Nothing of the",
      "default Gateway's or another named one's, which its names never match, so it may run in an",
      "account that holds a production Gateway: the allowlist and the forbidden list aren't read,",
      "CLOUDFLARE_API_TOKEN must still list the account, and the confirmation is the Gateway's",
      "Worker name every-app-gateway-<name>, typed or passed with --confirm, instead of the account",
      "id. --all tears down every Gateway in the account one after another, the named ones first",
      "and the default last, under the test-account guards and the account id's confirmation; it",
      "can't go with --gateway.",
      "",
      "Examples:",
      "  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --dry-run",
      "  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id>",
      "  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --confirm <id> --json",
      "  everyapp teardown --account-id <id> --gateway demo --dry-run",
      "  everyapp teardown --account-id <id> --gateway demo --confirm every-app-gateway-demo --json",
      "  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --all --confirm <id> --json",
    ].join("\n"),
  },
});
