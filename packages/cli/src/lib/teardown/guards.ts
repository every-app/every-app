/**
 * What stands between `everyapp teardown` and a Cloudflare account, in
 * the order it is checked, before any read of the account but `cf auth
 * whoami`, and before any write:
 *
 *   1. the account is not one that can never be torn down (FORBIDDEN_ACCOUNTS);
 *   2. the account is on the allowlist of dedicated test accounts:
 *      EVERYAPP_TEST_ACCOUNTS (ids separated by commas or whitespace) and
 *      the file `~/.config/everyapp/test-accounts` (one id per line, `#`
 *      comments; $XDG_CONFIG_HOME honoured), together;
 *   3. CLOUDFLARE_API_TOKEN is set: a `cf auth login` session is a person,
 *      who sees every account they belong to; a token is scoped;
 *   4. `cf auth whoami` lists only allowlisted accounts, none forbidden,
 *      and lists the one asked for.
 *
 * Every code the command raises is here, with a word on each.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CfWhoami } from "@/lib/cf/schemas";
import { EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { listed, plural } from "@/lib/output/text";

/** Accounts no configuration makes eligible: Ben's main account (openseo.so, everyapp.team). */
export const FORBIDDEN_ACCOUNTS: readonly string[] = ["23bc28f0b638fbfc1c7f838573c17ee3"];

/** The codes `teardown` raises (errors) and says (warnings), in one place. */
export enum TeardownCode {
  /** `--account-id` isn't 32 hex characters: no allowlist could ever hold it. */
  InvalidAccountId = "TEARDOWN_INVALID_ACCOUNT_ID",
  /** The account is in FORBIDDEN_ACCOUNTS: refused before the allowlist is read. */
  AccountForbidden = "TEARDOWN_ACCOUNT_FORBIDDEN",
  /** The account isn't in EVERYAPP_TEST_ACCOUNTS or the test-accounts file. */
  NotAllowlisted = "TEARDOWN_NOT_ALLOWLISTED",
  /** CLOUDFLARE_API_TOKEN isn't set: a login session sees too much. */
  NeedsToken = "TEARDOWN_NEEDS_TOKEN",
  /** The token sees an account outside the allowlist, or a forbidden one. */
  TokenTooBroad = "TEARDOWN_TOKEN_TOO_BROAD",
  /** The token doesn't list the account asked for. */
  AccountNotVisible = "TEARDOWN_ACCOUNT_NOT_VISIBLE",
  /** Without a terminal and without --confirm: the rerun carries `--confirm <id>`, to authorize. */
  ConfirmationRequired = "TEARDOWN_CONFIRMATION_REQUIRED",
  /** `--confirm` names another id than `--account-id`. */
  ConfirmMismatch = "TEARDOWN_CONFIRM_MISMATCH",
  /** Warning: an allowlist entry that isn't an account id was ignored. */
  AllowlistIgnored = "TEARDOWN_ALLOWLIST_IGNORED",
  /** Warning: one kind couldn't be listed (a permission, say); it is kept, and the run goes on. */
  ReadFailed = "TEARDOWN_READ_FAILED",
  /** Warning: one resource couldn't be deleted; it is kept, and the run goes on. */
  DeleteFailed = "TEARDOWN_DELETE_FAILED",
}

/** A Cloudflare account id: 32 lowercase hex characters. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

const isAccountId = (value: string): boolean => ACCOUNT_ID.test(value);

/** The environment variable listing test accounts, ids separated by commas or whitespace. */
const ALLOWLIST_VARIABLE = "EVERYAPP_TEST_ACCOUNTS";

/** The allowlist file: `$XDG_CONFIG_HOME/everyapp/test-accounts`, else `~/.config/everyapp/test-accounts`. */
export function allowlistPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return path.join(configHome, "everyapp", "test-accounts");
}

interface Allowlist {
  /** The account ids, each once, lowercased. */
  ids: string[];
  /** Entries that aren't account ids, as written. */
  ignored: string[];
}

/**
 * Ids out of text: the variable's (commas or whitespace between them) or
 * the file's (one per line, `#` starts a comment, blank lines skipped).
 * Anything that isn't 32 hex characters is ignored, and said.
 */
export function parseAllowlist(text: string): Allowlist {
  const ids = new Set<string>();
  const ignored: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/#.*$/, "");
    for (const entry of content.split(/[\s,]+/)) {
      if (!entry) continue;
      const id = entry.toLowerCase();
      if (isAccountId(id)) ids.add(id);
      else ignored.push(entry);
    }
  }
  return { ids: [...ids], ignored };
}

/** The variable's and the file's ids together (a missing file is an empty list). */
export function readAllowlist(env: NodeJS.ProcessEnv = process.env): Allowlist & { file: string } {
  const file = allowlistPath(env);
  let fromFile = "";
  try {
    fromFile = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const variable = parseAllowlist(env[ALLOWLIST_VARIABLE] ?? "");
  const listed = parseAllowlist(fromFile);
  return {
    ids: [...new Set([...variable.ids, ...listed.ids])],
    ignored: [...variable.ignored, ...listed.ignored],
    file,
  };
}

/** How to put an id on the allowlist, said in every refusal that needs it. */
function howToAllow(accountId: string, file: string): string {
  return [
    `only for a dedicated test account that holds nothing else (docs/runbooks/onboarding-loop-test-accounts.md):`,
    `set ${ALLOWLIST_VARIABLE}=${accountId} for this one command, or add a line ${accountId} to ${file}`,
  ].join(" ");
}

/**
 * Guards 1 to 3, with nothing of Cloudflare read: the account as the run
 * names it (lowercased), once it may be torn down as far as this machine
 * can tell. `env` is the process's unless a test says otherwise.
 */
export function checkAccountEligible({
  accountId: given,
  out,
  env = process.env,
}: {
  accountId: string;
  out: EventSink;
  env?: NodeJS.ProcessEnv;
}): { accountId: string; allowlist: string[] } {
  const accountId = given.trim().toLowerCase();
  // 0. An id at all: a malformed one could never be allowlisted, so the
  // refusal says so instead of sending the person to the allowlist.
  if (!isAccountId(accountId)) {
    throw new EveryAppError(
      TeardownCode.InvalidAccountId,
      `"${given.trim()}" isn't a Cloudflare account id\nAn account id is 32 hex characters (Compute (Workers) → Overview, or any dashboard URL dash.cloudflare.com/<account id>/...).`,
      { fix: "pass the test account's id from the dashboard as --account-id", data: { accountId: given.trim() } },
    );
  }
  // 1. Never, whatever any list says.
  if (FORBIDDEN_ACCOUNTS.includes(accountId)) {
    throw new EveryAppError(
      TeardownCode.AccountForbidden,
      `Cloudflare account ${accountId} can never be torn down\nIt is a live account, refused by id before any allowlist is read.`,
      { data: { accountId } },
    );
  }
  // 2. On the allowlist of test accounts.
  const allowlist = readAllowlist(env);
  if (allowlist.ignored.length > 0) {
    out.emit({
      type: "warning",
      code: TeardownCode.AllowlistIgnored,
      message: `Ignored ${plural(allowlist.ignored.length, "entry")} of the teardown allowlist that ${allowlist.ignored.length === 1 ? "isn't" : "aren't"} account ids: ${listed(allowlist.ignored)}\nAn account id is 32 hex characters (${ALLOWLIST_VARIABLE}, ${allowlist.file}).`,
      data: { ignored: allowlist.ignored, file: allowlist.file },
    });
  }
  if (!allowlist.ids.includes(accountId)) {
    throw new EveryAppError(
      TeardownCode.NotAllowlisted,
      `Cloudflare account ${accountId} isn't on the teardown allowlist\nteardown deletes everything EveryApp made in an account, so it runs only against accounts listed as dedicated test accounts.`,
      { fix: howToAllow(accountId, allowlist.file), data: { accountId, file: allowlist.file } },
    );
  }
  // 3. A token, not a person's login.
  if (!env["CLOUDFLARE_API_TOKEN"]) {
    throw new EveryAppError(
      TeardownCode.NeedsToken,
      `teardown needs CLOUDFLARE_API_TOKEN\nA Cloudflare login is a person, who sees every account they belong to; teardown runs only with an API token scoped to the test account (runbook step 5).`,
      { fix: `set CLOUDFLARE_API_TOKEN to the test account's token for this one command, and run it again`, data: { accountId } },
    );
  }
  return { accountId, allowlist: allowlist.ids };
}

/**
 * Guard 4, from `cf auth whoami` under the token: every account it lists
 * is allowlisted and none forbidden, and the one asked for is among them.
 */
export function checkTokenScope({
  accountId,
  allowlist,
  whoami,
}: {
  accountId: string;
  allowlist: readonly string[];
  whoami: CfWhoami;
}): void {
  // A bad env token still reads `authenticated: true`: cf says `tokenValid:
  // false` and lists no accounts (seen live with cf 1.0.0-beta.14).
  if (!whoami.authenticated || whoami.tokenValid === false) {
    throw new EveryAppError(
      "CLOUDFLARE_TOKEN_REJECTED",
      "Cloudflare didn't accept CLOUDFLARE_API_TOKEN\nIt may be mistyped, expired or revoked.",
      { fix: "set the test account's token (runbook step 5)" },
    );
  }
  // cf names what it authenticated with; anything but the environment
  // token is a person's login, whatever the environment says.
  if (whoami.authSource && !/CLOUDFLARE_API_TOKEN/.test(whoami.authSource)) {
    throw new EveryAppError(
      TeardownCode.NeedsToken,
      `teardown needs CLOUDFLARE_API_TOKEN, but cf authenticated with ${whoami.authSource}\nA Cloudflare login is a person, who sees every account they belong to; teardown runs only with an API token scoped to the test account (runbook step 5).`,
      {
        fix: "set CLOUDFLARE_API_TOKEN to the test account's token for this one command, and run it again",
        data: { accountId, authSource: whoami.authSource },
      },
    );
  }
  const seen = (whoami.accounts ?? []).map((account) => ({
    id: account.id.toLowerCase(),
    name: account.name ?? null,
  }));
  const outside = seen.filter((account) => FORBIDDEN_ACCOUNTS.includes(account.id) || !allowlist.includes(account.id));
  if (outside.length > 0) {
    throw new EveryAppError(
      TeardownCode.TokenTooBroad,
      [
        `CLOUDFLARE_API_TOKEN sees ${plural(outside.length, "account")} that ${outside.length === 1 ? "isn't a" : "aren't"} test account${outside.length === 1 ? "" : "s"}: ${listed(outside.map((account) => (account.name ? `${account.name} (${account.id})` : account.id)))}`,
        "A teardown token must be scoped to the test account alone (Account Resources → Include → that account), so there is no path from here to a live account.",
      ].join("\n"),
      { fix: "mint a token for the test account only (runbook step 5)", data: { accountId, accounts: outside } },
    );
  }
  if (!seen.some((account) => account.id === accountId)) {
    throw new EveryAppError(
      TeardownCode.AccountNotVisible,
      `CLOUDFLARE_API_TOKEN doesn't list Cloudflare account ${accountId}\n${seen.length === 0 ? "It lists no accounts." : `It lists ${listed(seen.map((account) => account.id))}.`}`,
      {
        fix: "use that account's token, with Account Settings: Read on it (runbook step 5)",
        data: { accountId, accounts: seen },
      },
    );
  }
}
