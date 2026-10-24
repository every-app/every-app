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
          "The dedicated test account to empty (required; never read from CLOUDFLARE_ACCOUNT_ID)",
      },
      confirm: {
        kind: "parsed",
        parse: String,
        placeholder: "id",
        optional: true,
        brief:
          "The same account id again, for a run without a terminal (--json, a script); at a terminal it is typed instead",
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
    brief: "Delete everything Every App created in a dedicated test Cloudflare account",
    fullDescription: [
      "For the accounts the onboarding loop installs into, over and over: removes every Worker,",
      "Workflow, D1 database, KV namespace, R2 bucket and Hyperdrive config named every-*, the",
      "Gateway's own included, the two Cloudflare Access applications and the allow policy, the",
      "Email Routing rules that send mail to those Workers (a catch-all drops mail again, and",
      "routing is turned off once no rule and no catch-all of anyone else's needs it), the",
      "certificate packs of the hostnames the Gateway published, and the Custom Domain records",
      "(A, AAAA, CNAME) left at exactly those names. Never the zone, the Workers Paid subscription,",
      "the workers.dev subdomain, the Zero Trust team and its identity providers, any other DNS",
      "record (MX, TXT, CAA...) even at those names, R2 buckets outside the default jurisdiction,",
      "or anything whose name doesn't start with every- and that no app recorded.",
      "",
      "It is destructive and exists for dedicated test accounts only. The account must be on the",
      "allowlist (EVERYAPP_TEST_ACCOUNTS, or one id per line in ~/.config/everyapp/test-accounts),",
      "the run needs CLOUDFLARE_API_TOKEN scoped to that account alone (a token that sees any other",
      "account is refused), and one account is refused by id whatever the lists say. It reads",
      "everything first and shows what it found; then the account id is typed at the terminal, or",
      "passed again with --confirm for a run without one. There is no --yes.",
      "",
      "Examples:",
      "  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --dry-run",
      "  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id>",
      "  EVERYAPP_TEST_ACCOUNTS=<id> everyapp teardown --account-id <id> --confirm <id> --json",
    ].join("\n"),
  },
});
