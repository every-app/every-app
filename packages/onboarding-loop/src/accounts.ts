/**
 * The two files Ben writes by hand (design 6, 4.14) and nothing else:
 * `~/.config/everyapp/onboarding-loop/accounts.json` (mode 600,
 * `{accounts:[{name, accountId, zone, email, token}]}`) and `providers.env`
 * (mode 600, one `VAR=value` per line). The driver refuses to start when
 * `EVERYAPP_TEST_ACCOUNTS`, `CLOUDFLARE_API_TOKEN` or `EVERYAPP_GATEWAY_URL`
 * is already in its own environment (the allowlist and the token are
 * derived from the file for each child, never inherited), refuses the
 * forbidden account id by constant, and refuses a value whose hash matches
 * a `rotate.json` an earlier run wrote after an agent echoed it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { FORBIDDEN_ACCOUNT_IDS } from "./cf";
import type { Account, AccountsFile, Providers, ProviderVar } from "./types";

const REFUSED_ENV_VARS = [
  "EVERYAPP_TEST_ACCOUNTS",
  "CLOUDFLARE_API_TOKEN",
  "EVERYAPP_GATEWAY_URL",
] as const;

const PROVIDER_VARS: readonly ProviderVar[] = [
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "OPENCODE_API_KEY",
  "CURSOR_API_KEY",
];

type AccountsErrorCode =
  | "env_inherited"
  | "file_missing"
  | "file_mode"
  | "file_invalid"
  | "account_forbidden"
  | "account_unknown"
  | "rotate_refused";

export class AccountsError extends Error {
  constructor(
    readonly code: AccountsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountsError";
  }
}

/** `$XDG_CONFIG_HOME/everyapp/onboarding-loop`, else `~/.config/everyapp/onboarding-loop`. */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configHome = env["XDG_CONFIG_HOME"] || path.join(home, ".config");
  return path.join(configHome, "everyapp", "onboarding-loop");
}

const accountsPath = (dir: string): string => path.join(dir, "accounts.json");
const providersPath = (dir: string): string => path.join(dir, "providers.env");
export const locksDir = (dir: string): string => path.join(dir, "locks");
export const runsDir = (dir: string): string => path.join(dir, "runs");
/** `confirm-<accountId>`: the unattended teardown confirmation Ben writes once. */
export const confirmPath = (dir: string, accountId: string): string =>
  path.join(dir, `confirm-${accountId}`);

/** The driver's own environment must not carry what it derives for its children. */
export function refuseInheritedEnv(env: NodeJS.ProcessEnv = process.env): void {
  const set = REFUSED_ENV_VARS.filter((name) => env[name] !== undefined);
  if (set.length > 0) {
    throw new AccountsError(
      "env_inherited",
      `${set.join(", ")} ${set.length === 1 ? "is" : "are"} set in the loop's own environment. Unset ${
        set.length === 1 ? "it" : "them"
      }: the loop derives them from accounts.json for each child it runs.`,
    );
  }
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

const AccountSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a name like loop-1"),
  accountId: z
    .string()
    .transform((id) => id.toLowerCase())
    .pipe(z.string().regex(ACCOUNT_ID, "32 hex characters")),
  zone: z
    .string()
    .transform((zone) => zone.toLowerCase())
    .pipe(
      z
        .string()
        .regex(
          /^[a-z0-9-]+(\.[a-z0-9-]+)+$/,
          "a domain like everyapp-loop1.com",
        ),
    ),
  email: z.string().email(),
  token: z.string().min(20, "the API token"),
});

const AccountsFileSchema = z.object({
  accounts: z.array(AccountSchema).min(1),
});

/** Reads a file only this user may read (mode 600, or stricter). */
function readPrivate(file: string, what: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AccountsError(
        "file_missing",
        `${what} is missing: ${file} (docs/runbooks/onboarding-loop-test-accounts.md).`,
      );
    }
    throw error;
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AccountsError(
      "file_mode",
      `${file} must be mode 600 (chmod 600 ${file}); it is ${(stat.mode & 0o777).toString(8)}.`,
    );
  }
  return fs.readFileSync(file, "utf8");
}

export function parseAccountsFile(
  text: string,
  file = "accounts.json",
): AccountsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AccountsError("file_invalid", `${file} is not JSON.`);
  }
  const parsed = AccountsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AccountsError(
      "file_invalid",
      `${file}: ${issue?.path.join(".")} ${issue?.message}`,
    );
  }
  const names = new Set<string>();
  for (const account of parsed.data.accounts) {
    if (FORBIDDEN_ACCOUNT_IDS.includes(account.accountId)) {
      throw new AccountsError(
        "account_forbidden",
        `${file} lists a forbidden account under "${account.name}".`,
      );
    }
    if (names.has(account.name))
      throw new AccountsError(
        "file_invalid",
        `${file} names "${account.name}" twice.`,
      );
    names.add(account.name);
  }
  return parsed.data;
}

export function loadAccountsFile(dir: string): AccountsFile {
  const file = accountsPath(dir);
  return parseAccountsFile(readPrivate(file, "accounts.json"), file);
}

export function findAccount(accounts: AccountsFile, name: string): Account {
  const account = accounts.accounts.find((row) => row.name === name);
  if (!account) {
    throw new AccountsError(
      "account_unknown",
      `No account "${name}" in accounts.json; it has ${accounts.accounts.map((row) => row.name).join(", ")}.`,
    );
  }
  return account;
}

/** `VAR=value` lines, `#` comments, optional quotes; only the four provider variables are accepted. */
export function parseProvidersEnv(
  text: string,
  file = "providers.env",
): Providers {
  const providers: Providers = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match)
      throw new AccountsError(
        "file_invalid",
        `${file} line ${index + 1} is not VAR=value.`,
      );
    const name = match[1]!;
    const value = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
    if (!(PROVIDER_VARS as readonly string[]).includes(name)) {
      throw new AccountsError(
        "file_invalid",
        `${file} line ${index + 1}: ${name} is not a provider variable (${PROVIDER_VARS.join(", ")}).`,
      );
    }
    // A value still reading REPLACE… is the placeholder from the files the
    // runbook has Ben fill in: unset, so `accounts` says so and a run
    // refuses at preflight instead of handing a harness a fake key.
    if (value.length > 0 && !/^REPLACE/i.test(value))
      providers[name as ProviderVar] = value;
  }
  return providers;
}

/** A missing providers.env is an empty set: the control harness needs no provider. */
export function loadProviders(dir: string): Providers {
  const file = providersPath(dir);
  try {
    return parseProvidersEnv(readPrivate(file, "providers.env"), file);
  } catch (error) {
    if (error instanceof AccountsError && error.code === "file_missing")
      return {};
    throw error;
  }
}

/** One row per account for `loop accounts`: never the id, never the token. */
export function describeAccounts(
  accounts: AccountsFile,
): Array<{ name: string; zone: string; email: string }> {
  return accounts.accounts.map(({ name, zone, email }) => ({
    name,
    zone,
    email,
  }));
}

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** `runs/<runId>/rotate.json`: the hashes of values an agent echoed in that run. */
export interface RotateFile {
  values: Array<{ name: "cf_token" | "provider_key"; sha256: string }>;
}

interface RotateMarker {
  runId: string;
  name: RotateFile["values"][number]["name"];
  sha256: string;
}

export function readRotateMarkers(runs: string): RotateMarker[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(runs);
  } catch {
    return [];
  }
  const markers: RotateMarker[] = [];
  for (const runId of entries) {
    try {
      const file = JSON.parse(
        fs.readFileSync(path.join(runs, runId, "rotate.json"), "utf8"),
      ) as RotateFile;
      for (const value of file.values ?? [])
        markers.push({ runId, name: value.name, sha256: value.sha256 });
    } catch {
      // No rotate.json in that run, or not readable: nothing to refuse on.
    }
  }
  return markers;
}

/** Why a value may not be used: it was echoed in a run and has not been rolled since. */
export function rotateRefusal(
  markers: RotateMarker[],
  value: string,
): RotateMarker | null {
  const hash = sha256(value);
  return markers.find((marker) => marker.sha256 === hash) ?? null;
}

/** The `accounts` command: names, zones and emails, and whether each provider variable is present. */
export function accountsMain(dir: string = configDir()): string[] {
  refuseInheritedEnv();
  const accounts = loadAccountsFile(dir);
  const providers = loadProviders(dir);
  const lines = describeAccounts(accounts).map(
    (account) =>
      `${account.name}  zone ${account.zone}  owner ${account.email}`,
  );
  lines.push(
    `providers: ${PROVIDER_VARS.map((name) => `${name}=${providers[name] ? "set" : "unset"}`).join(" ")}`,
  );
  return lines;
}
