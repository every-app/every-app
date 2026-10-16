/**
 * Who cf is logged in as, and which Cloudflare account a command acts on.
 * The CLI never sees a Cloudflare token: cf keeps its own credentials, and
 * CI passes CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID straight through.
 */
import enquirer from "enquirer";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { handTerminalOver } from "@/lib/output/terminal";
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

/** How long a person has to approve cf's device login. */
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

interface DeviceLogin {
  url: string;
  code: string;
}

/**
 * For `ensureCfAuth` under --json: cf's device link and code go to the
 * agent reading the events as `action_required cloudflare_login` with
 * `waiting: true`, and the run waits for a person to approve it.
 */
export function deviceLoginAction(
  out: EventSink,
  step: string,
): (login: DeviceLogin) => void {
  return (login) =>
    out.emit({
      type: "action_required",
      action: "cloudflare_login",
      step,
      message:
        "Log in to Cloudflare: open the link and enter the code (waiting for it).",
      data: { url: login.url, code: login.code, waiting: true },
    });
}

/**
 * Make sure cf is logged in. A person at a terminal is taken through
 * `cf auth login` (a device code, so it works over SSH too). With
 * `onDeviceLogin`, an unattended run (an agent reading `--json`) does the
 * same: it hands cf's link and code over and waits for a person to approve.
 * Anyone else is told to log in, or to set CLOUDFLARE_API_TOKEN.
 */
export async function ensureCfAuth({
  cf,
  interactive,
  onDeviceLogin,
}: {
  cf: CfRunner;
  interactive: boolean;
  onDeviceLogin?: (login: DeviceLogin) => void;
}): Promise<CfWhoami> {
  const whoami = await cfWhoami(cf);
  if (whoami.authenticated) return whoami;
  if (process.env["CLOUDFLARE_API_TOKEN"]) {
    throw new EveryAppError(
      "CLOUDFLARE_TOKEN_REJECTED",
      "cf can't authenticate with CLOUDFLARE_API_TOKEN. Check the token is valid and has the Workers, D1 and KV permissions.",
    );
  }
  if (interactive) {
    await cf.run({ plane: "account", mode: "interactive", args: ["auth", "login"] });
  } else if (onDeviceLogin) {
    await deviceLogin(cf, onDeviceLogin);
  } else {
    throw new ActionRequiredError(
      "cloudflare_login",
      "Log in to Cloudflare first: run `npx cf auth login` (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID), then run this command again.",
    );
  }
  const loggedIn = await cfWhoami(cf);
  if (!loggedIn.authenticated) {
    throw new EveryAppError(
      "CLOUDFLARE_LOGIN_FAILED",
      "Cloudflare login didn't complete. Run `npx cf auth login`, then this command again.",
    );
  }
  return loggedIn;
}

/**
 * `cf auth login --no-browser`, piped: cf prints "please visit: <url> … and
 * enter the code: <code>", then waits for the approval. The link and code
 * go to `onDeviceLogin` as soon as both are out.
 */
async function deviceLogin(
  cf: CfRunner,
  onDeviceLogin: (login: DeviceLogin) => void,
): Promise<void> {
  let output = "";
  let announced = false;
  try {
    await cf.run({
      plane: "account",
      mode: "text",
      timeoutMs: DEVICE_LOGIN_TIMEOUT_MS,
      args: ["auth", "login", "--no-browser"],
      onOutput: (chunk) => {
        output += chunk;
        const url = /please visit:\s*(https?:\/\/\S+)/i.exec(output)?.[1];
        const code = /enter the code:\s*(\S+)/i.exec(output)?.[1];
        if (announced || !url || !code) return;
        announced = true;
        onDeviceLogin({ url, code });
      },
    });
  } catch (error) {
    throw new EveryAppError(
      "CLOUDFLARE_LOGIN_FAILED",
      `Cloudflare login didn't complete (${error instanceof Error ? error.message : String(error)}). Run \`npx cf auth login\` yourself, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, then run this command again.`,
      { retryable: true },
    );
  }
}

interface ResolveAccountOptions {
  whoami: CfWhoami;
  /** --account-id */
  flag?: string;
  interactive: boolean;
}

/**
 * The account to install a Gateway in, when none of the login's accounts
 * has one (lib/gateway/discover.ts finds those): --account-id, then
 * CLOUDFLARE_ACCOUNT_ID, then the only account cf can see, then a choice at
 * the terminal.
 */
export async function resolveAccount({
  whoami,
  flag,
  interactive,
}: ResolveAccountOptions): Promise<Account> {
  const accounts: Account[] = (whoami.accounts ?? []).map((account) => ({
    id: account.id,
    name: account.name ?? null,
  }));
  const named = (id: string): Account =>
    accounts.find((account) => account.id === id) ?? { id, name: null };

  const chosen = flag || process.env["CLOUDFLARE_ACCOUNT_ID"] || undefined;
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
  handTerminalOver();
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
