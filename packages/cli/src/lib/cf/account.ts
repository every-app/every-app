/**
 * Who cf is logged in as, and which Cloudflare account a command acts on.
 * The CLI never sees a Cloudflare token: cf keeps its own credentials, and
 * CI passes CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID straight through.
 */
import enquirer from "enquirer";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { runCfJson, type CfRunner } from "./runner";
import { CfWhoamiOutput, type CfWhoami } from "./schemas";

interface Account {
  id: string;
  name: string | null;
}

async function cfWhoami(cf: CfRunner): Promise<CfWhoami> {
  return runCfJson(
    cf,
    { plane: "account", args: ["auth", "whoami"] },
    CfWhoamiOutput,
  );
}

/**
 * Make sure cf is logged in. A person at a terminal is taken through
 * `cf auth login` (a device code, so it works over SSH too); anyone else is
 * told to log in, or to set CLOUDFLARE_API_TOKEN.
 */
export async function ensureCfAuth({
  cf,
  interactive,
}: {
  cf: CfRunner;
  interactive: boolean;
}): Promise<CfWhoami> {
  const whoami = await cfWhoami(cf);
  if (whoami.authenticated) return whoami;
  if (process.env["CLOUDFLARE_API_TOKEN"]) {
    throw new EveryAppError(
      "CLOUDFLARE_TOKEN_REJECTED",
      "cf can't authenticate with CLOUDFLARE_API_TOKEN. Check the token is valid and has the Workers, D1 and KV permissions.",
    );
  }
  if (!interactive) {
    throw new ActionRequiredError(
      "cloudflare_login",
      "Log in to Cloudflare first: run `npx cf auth login` (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID), then run this command again.",
    );
  }
  await cf.run({ plane: "account", mode: "interactive", args: ["auth", "login"] });
  const loggedIn = await cfWhoami(cf);
  if (!loggedIn.authenticated) {
    throw new EveryAppError(
      "CLOUDFLARE_LOGIN_FAILED",
      "Cloudflare login didn't complete. Run `npx cf auth login`, then this command again.",
    );
  }
  return loggedIn;
}

interface ResolveAccountOptions {
  whoami: CfWhoami;
  /** --account-id */
  flag?: string;
  /** The account a previous run of this install used. */
  remembered?: string;
  interactive: boolean;
}

/**
 * The account to act on: --account-id, then CLOUDFLARE_ACCOUNT_ID, then the
 * one this install used before, then the only account cf can see, then a
 * choice at the terminal.
 */
export async function resolveAccount({
  whoami,
  flag,
  remembered,
  interactive,
}: ResolveAccountOptions): Promise<Account> {
  const accounts: Account[] = (whoami.accounts ?? []).map((account) => ({
    id: account.id,
    name: account.name ?? null,
  }));
  const named = (id: string): Account =>
    accounts.find((account) => account.id === id) ?? { id, name: null };

  const chosen =
    flag || process.env["CLOUDFLARE_ACCOUNT_ID"] || remembered || undefined;
  if (chosen) {
    if (accounts.length > 0 && !accounts.some((a) => a.id === chosen)) {
      throw new EveryAppError(
        "ACCOUNT_NOT_ACCESSIBLE",
        `cf is logged in${whoami.email ? ` as ${whoami.email}` : ""} without access to Cloudflare account ${chosen}. Log in to that account (npx cf auth login) or choose another.`,
      );
    }
    return named(chosen);
  }
  if (accounts.length === 1) return accounts[0]!;
  if (accounts.length === 0) {
    throw new EveryAppError(
      "ACCOUNT_REQUIRED",
      "cf lists no Cloudflare accounts for this login. Pass --account-id or set CLOUDFLARE_ACCOUNT_ID.",
    );
  }
  if (!interactive) {
    throw new EveryAppError(
      "ACCOUNT_REQUIRED",
      `This login can use several Cloudflare accounts; pass --account-id with one of: ${accounts
        .map((account) => `${account.id} (${account.name ?? "unnamed"})`)
        .join(", ")}.`,
    );
  }
  const { accountId } = await enquirer.prompt<{ accountId: string }>({
    type: "select",
    name: "accountId",
    message: "Which Cloudflare account?",
    choices: accounts.map((account) => ({
      name: account.id,
      message: `${account.name ?? account.id} (${account.id})`,
    })),
  });
  return named(accountId);
}
