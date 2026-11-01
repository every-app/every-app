/**
 * Who cf is logged in as, and which Cloudflare account a command acts on.
 * The CLI never sees a Cloudflare token: cf keeps its own credentials, and
 * CI passes CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID straight through.
 */
import chalk from "chalk";
import { ActionRequiredError, errorMessage, EveryAppError } from "@/lib/errors";
import { CLI, thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { choose, tellPerson } from "@/lib/output/prompt";
import { roughly } from "@/lib/output/time";
import { CfTimeoutError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import { CfWhoamiOutput, type CfWhoami } from "./schemas";

interface Account {
  id: string;
  name: string | null;
}

/** The login's email, once `cf auth whoami` said it (null for an API token). */
let loginEmail: string | null = null;

/** Who cf is logged in as (`authenticated: false` when it isn't). */
export async function cfWhoami(cf: CfRunner): Promise<CfWhoami> {
  const whoami = await runCfJson(
    cf,
    { plane: "account", args: ["auth", "whoami"] },
    CfWhoamiOutput,
  );
  loginEmail =
    whoami.authenticated && !process.env["CLOUDFLARE_API_TOKEN"] ? (whoami.email ?? null) : null;
  return whoami;
}

/**
 * Who this run acts as, for what others see of it (a deploy lease's
 * holder): the Cloudflare login's email once this run checked it, else
 * null (not logged in yet, or an API token, whose user isn't who runs it).
 */
export function loggedInAs(): string | null {
  return loginEmail;
}

/**
 * How long a person has to approve cf's device login: cf's device code
 * lives 5 minutes (the pinned cf 1.0.0-beta.14 caps it at 300 s,
 * `Math.min(expires_in, 300)`), so this run stops waiting then too.
 */
const DEVICE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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
        // cf stops waiting for the approval then (the timeout below).
        expiresAt: new Date(Date.now() + DEVICE_LOGIN_TIMEOUT_MS).toISOString(),
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
      "Cloudflare didn't accept CLOUDFLARE_API_TOKEN\nIt may be mistyped, expired or revoked.\nA token needs Account › Workers Scripts › Edit, Account › D1 › Edit, Account › Workers KV Storage › Edit, Zone › Zone › Read and Zone › DNS › Read: https://dash.cloudflare.com/profile/api-tokens",
      { fix: `set a valid token, or unset CLOUDFLARE_API_TOKEN and run ${CLI} login` },
    );
  }
  if (interactive) {
    tellPerson(
      `${chalk.cyan("→")} Log in to Cloudflare to continue\n${chalk.dim("  Starting Cloudflare's login. Open its link and enter the code.")}`,
    );
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
  if (interactive) {
    tellPerson(`Logged in to Cloudflare${loggedIn.email ? ` as ${loggedIn.email}` : ""} ${chalk.green("✓")}`);
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
        : `Cloudflare login didn't complete\n${errorMessage(error)}`,
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
          fix: "pass one of these with --account-id, or log in as someone else",
        },
      );
    }
    return named(chosen);
  }
  if (accounts.length === 1) return accounts[0]!;
  if (accounts.length === 0) {
    throw new EveryAppError(
      "ACCOUNT_REQUIRED",
      "This Cloudflare login can't list any accounts\nThe account id is in your dashboard URL: dash.cloudflare.com/<account-id>/…",
      { fix: "pass --account-id, or set CLOUDFLARE_ACCOUNT_ID" },
    );
  }
  if (!interactive) {
    // One command per account, ready to run: no single rerun fits.
    throw new ActionRequiredError(
      "choose_account",
      `Choose the Cloudflare account to install in\n${whoami.email ?? "This login"} can use ${accounts.length} accounts. Run one of:`,
      undefined,
      {
        rerun: null,
        data: {
          choices: accounts.map((account) => ({
            accountId: account.id,
            accountName: account.name,
            label: account.name,
            rerun: thisCommand(["--account-id", account.id]),
          })),
        },
      },
    );
  }
  return choose(
    "Which account should the Gateway go in?",
    accounts.map((account) => ({ label: account.name ?? account.id, value: account })),
    {
      context: [
        `${whoami.email ?? "This login"} can use ${accounts.length} Cloudflare accounts`,
      ],
    },
  );
}
