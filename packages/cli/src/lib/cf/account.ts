/**
 * Who cf is logged in as, and which Cloudflare account a command acts on.
 * The CLI never sees a Cloudflare token: cf keeps its own credentials, and
 * CI passes CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID straight through.
 */
import enquirer from "enquirer";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { roughly } from "@/lib/output/roughly";
import { handTerminalOver } from "@/lib/output/terminal";
import { CfTimeoutError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import { CfWhoamiOutput, type CfWhoami } from "./schemas";

interface Account {
  id: string;
  name: string | null;
}

/** Who cf is logged in as (`authenticated: false` when it isn't). */
export async function cfWhoami(cf: CfRunner): Promise<CfWhoami> {
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
 * For an unattended login (an agent reading --json, `everyapp login`
 * piped): cf's device link and code go out as `action_required
 * cloudflare_login` with `waiting: true`, and the run waits for a person to
 * approve it.
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
      message: "Log in to Cloudflare: open this link and enter the code",
      data: {
        url: login.url,
        code: login.code,
        waiting: true,
        waitingFor: "Cloudflare login",
      },
    });
}

interface LogInOptions {
  cf: CfRunner;
  interactive: boolean;
  onDeviceLogin?: (login: DeviceLogin) => void;
}

/** Make sure cf is logged in, logging it in (`logIn`) when it isn't. */
export async function ensureCfAuth(options: LogInOptions): Promise<CfWhoami> {
  const whoami = await cfWhoami(options.cf);
  if (whoami.authenticated) return whoami;
  return logIn(options);
}

/**
 * Log cf in, once `cf auth whoami` said it isn't. A person at a terminal
 * is taken through `cf auth login` (a device code, so it works over SSH
 * too). With `onDeviceLogin`, an unattended run does the same: it hands
 * cf's link and code over and waits for a person to approve. Anyone else
 * is told to run `everyapp login`, or to set CLOUDFLARE_API_TOKEN. Returns
 * who cf is logged in as now.
 */
export async function logIn({
  cf,
  interactive,
  onDeviceLogin,
}: LogInOptions): Promise<CfWhoami> {
  if (process.env["CLOUDFLARE_API_TOKEN"]) {
    throw new EveryAppError(
      "CLOUDFLARE_TOKEN_REJECTED",
      "Cloudflare didn't accept CLOUDFLARE_API_TOKEN\nIt may be mistyped, expired or revoked.\nA token needs Workers, D1, KV and Zone DNS Read access: https://dash.cloudflare.com/profile/api-tokens",
      { data: { fix: `set a valid token, or unset CLOUDFLARE_API_TOKEN and run ${CLI} login` } },
    );
  }
  if (interactive) {
    await cf.run({ plane: "account", mode: "interactive", args: ["auth", "login"] });
  } else if (onDeviceLogin) {
    await deviceLogin(cf, onDeviceLogin);
  } else {
    throw new ActionRequiredError(
      "cloudflare_login",
      `Log in to Cloudflare with ${CLI} login\nUnattended? Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID instead.`,
    );
  }
  const loggedIn = await cfWhoami(cf);
  if (!loggedIn.authenticated) {
    throw new EveryAppError("CLOUDFLARE_LOGIN_FAILED", "Cloudflare login didn't complete", {
      rerun: `${CLI} login`,
    });
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
      error instanceof CfTimeoutError
        ? `Cloudflare login timed out after ${roughly(DEVICE_LOGIN_TIMEOUT_MS)}\nOr set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.`
        : `Cloudflare login didn't complete\n${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, rerun: `${CLI} login` },
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
      const width = Math.max(...accounts.map((a) => (a.name ?? a.id).length));
      throw new EveryAppError(
        "ACCOUNT_NOT_ACCESSIBLE",
        [
          `${whoami.email ?? "This login"} can't use Cloudflare account ${chosen}`,
          "Accounts this login can use:",
          ...accounts.map((a) => `  ${(a.name ?? a.id).padEnd(width)}  ${a.id}`),
        ].join("\n"),
        {
          rerun: `${CLI} login`,
          data: { fix: "pass one of these with --account-id, or log in as someone else" },
        },
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
