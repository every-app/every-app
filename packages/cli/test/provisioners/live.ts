/**
 * The live harness of the resource-kind tests (`*.live.test.ts` beside
 * this file): one Cloudflare test account, never anyone's own. Each test
 * is skipped unless EVERYAPP_LIVE_PROVISIONERS=1, so `pnpm test` and CI
 * never reach Cloudflare; a person runs one with
 *
 *   EVERYAPP_LIVE_PROVISIONERS=1 pnpm -C packages/cli exec vitest run test/provisioners/<kind>.live.test.ts
 *
 * The account comes from the onboarding loop's file
 * (`~/.config/everyapp/onboarding-loop/accounts.json`, mode 600, written
 * by hand; docs/runbooks/onboarding-loop-test-accounts.md), read in this
 * process and handed to `cf` only through the child's environment: the
 * token is never printed, logged or written. The harness refuses to run
 * unless `cf auth whoami` with that environment says the token is what it
 * authenticated with and it sees exactly the one account, which is never
 * on the teardown's forbidden list (EVERYAPP_FORBIDDEN_ACCOUNTS and
 * `~/.config/everyapp/forbidden-accounts`, under the real home), and unless no loop run
 * holds the account's lock. Everything a test makes is named
 * `every-provisioners-…`, which the teardown's `every-` scan would find,
 * and each test deletes what it made in a `finally`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe } from "vitest";
import { z } from "zod";
import { cfDeploy } from "@/lib/cf/deploy";
import { isCfError } from "@/lib/cf/errors";
import { createCfRunner, runCfJson, type CfRunner } from "@/lib/cf/runner";
import { CfWhoamiOutput } from "@/lib/cf/schemas";
import { deleteWorker, getWorkerDeployment } from "@/lib/cf/workers";
import { readForbiddenList } from "@/lib/teardown/guards";

/** Whether this run may reach the test account. */
const LIVE = process.env["EVERYAPP_LIVE_PROVISIONERS"] === "1";

/** `describe` for a live suite: skipped without the flag. */
export const describeLive = LIVE ? describe : describe.skip;

/** Every Worker and resource a live test makes starts so. */
export const LIVE_PREFIX = "every-provisioners-";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

const AccountsFile = z.object({
  accounts: z.array(
    z.object({
      name: z.string(),
      accountId: z.string().transform((id) => id.toLowerCase()),
      zone: z.string(),
      email: z.string(),
      token: z.string().min(20),
    }),
  ),
});

interface LiveAccount {
  /** cf pinned to the account, the token in its environment. */
  cf: CfRunner;
  accountId: string;
  zone: string;
  name: string;
}

/**
 * The loop's config directory, under the real home: the test setup
 * rebinds HOME to an empty directory, so `os.homedir()` would miss it.
 */
function loopConfigDir(): string {
  const home = os.userInfo().homedir;
  const configHome = process.env["XDG_CONFIG_HOME"] || path.join(home, ".config");
  return path.join(configHome, "everyapp", "onboarding-loop");
}

/**
 * The test account `name` (default `loop-1`), checked: the file's mode,
 * the id, the forbidden list, no loop lock, and cf's own word on what it
 * authenticated with. Throws a message that names the problem and never
 * the token.
 */
export async function liveAccount(name = "loop-1"): Promise<LiveAccount> {
  const dir = loopConfigDir();
  const file = path.join(dir, "accounts.json");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`No ${file}: see docs/runbooks/onboarding-loop-test-accounts.md.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${file} must be mode 600 (chmod 600 ${file}).`);
  }
  const parsed = AccountsFile.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} isn't the loop's accounts file.`);
  const account = parsed.data.accounts.find((row) => row.name === name);
  if (!account) {
    throw new Error(`No account "${name}" in ${file}; it has ${parsed.data.accounts.map((row) => row.name).join(", ")}.`);
  }
  if (!ACCOUNT_ID.test(account.accountId)) throw new Error(`${name}'s account id isn't 32 hex characters.`);
  const configHome = process.env["XDG_CONFIG_HOME"] || path.join(os.userInfo().homedir, ".config");
  if (readForbiddenList({ ...process.env, XDG_CONFIG_HOME: configHome }).ids.includes(account.accountId)) {
    throw new Error(`${name} is on the forbidden list; never a test account.`);
  }
  const lock = path.join(dir, "locks", `${account.accountId}.json`);
  if (fs.existsSync(lock)) {
    throw new Error(`A loop run holds ${name} (${lock}); run the live test once it is done.`);
  }

  // The token reaches cf through the child's environment and nothing else.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: account.token,
    CLOUDFLARE_ACCOUNT_ID: account.accountId,
  };
  delete env["CLOUDFLARE_API_KEY"];
  delete env["CLOUDFLARE_EMAIL"];
  const cf = createCfRunner({ accountId: account.accountId, env });
  const whoami = await runCfJson(cf, { plane: "account", args: ["auth", "whoami"] }, CfWhoamiOutput);
  const source = whoami.authSource ?? "";
  if (!whoami.authenticated || whoami.tokenValid === false || !/CLOUDFLARE_API_TOKEN/.test(source)) {
    throw new Error(
      `cf didn't authenticate with ${name}'s token (authSource: ${JSON.stringify(source)}, tokenValid: ${String(whoami.tokenValid)}); nothing ran.`,
    );
  }
  const accounts = whoami.accounts ?? [];
  if (accounts.length !== 1 || accounts[0]!.id.toLowerCase() !== account.accountId) {
    throw new Error(`${name}'s token sees ${accounts.length} account(s), not exactly its own; nothing ran.`);
  }
  return { cf, accountId: account.accountId, zone: account.zone, name: account.name };
}

/** The bindings a prebuilt Worker is uploaded with, by binding name. */
type PrebuiltEnv = Record<string, Record<string, unknown> & { type: string }>;

interface PrebuiltWorker {
  /** Must start with {@link LIVE_PREFIX}. */
  workerName: string;
  env: PrebuiltEnv;
  /** cf's triggers (a queue consumer, a cron). */
  triggers?: Array<Record<string, unknown> & { type: string }>;
  /** Export a `queue()` handler beside `fetch` (a queue consumer needs one, or cf fails after the upload). */
  queueHandler?: boolean;
}

/** The exact `worker.config.json` {@link uploadPrebuilt} writes for `worker`. */
function prebuiltWorkerConfig(worker: PrebuiltWorker): Record<string, unknown> {
  return {
    name: worker.workerName,
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    ...(worker.triggers?.length ? { triggers: worker.triggers } : {}),
    env: worker.env,
    manifest: { type: "partial", mainModule: "index.js", modules: {} },
  };
}

/**
 * Upload a tiny Worker binding `env` through the CLI's own
 * `cf deploy --prebuilt` path (lib/cf/deploy.ts), from a Build Output
 * written under the system temp directory (never under /tmp itself: cf
 * reads a `.cloudflare/cache` it finds in a parent directory, and /tmp
 * holds one for whoever ran cf there). Returns the version id.
 */
export async function uploadPrebuilt(live: LiveAccount, worker: PrebuiltWorker): Promise<string> {
  if (!worker.workerName.startsWith(LIVE_PREFIX)) {
    throw new Error(`A live test's Worker is named ${LIVE_PREFIX}…, not ${worker.workerName}.`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-live-"));
  try {
    const out = path.join(root, ".cloudflare", "output", "v0");
    const bundle = path.join(out, "workers", "default", "bundle");
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(
      path.join(out, "config.json"),
      JSON.stringify({ buildContext: { isPreview: false, mode: "production" } }),
    );
    fs.writeFileSync(
      path.join(out, "workers", "default", "worker.config.json"),
      `${JSON.stringify(prebuiltWorkerConfig(worker), null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(bundle, "index.js"),
      [
        "export default {",
        '  fetch() { return new Response("ok"); },',
        ...(worker.queueHandler ? ["  async queue() {},"] : []),
        "};",
        "",
      ].join("\n"),
    );
    const result = await cfDeploy({
      cf: live.cf,
      cwd: root,
      cliCf: true,
      workerName: worker.workerName,
      accountId: live.accountId,
      message: `provisioners live test ${worker.workerName}`,
      interactive: false,
      attach: false,
    });
    if (!result.versionId) throw new Error(`cf reported no version for ${worker.workerName}.`);
    return result.versionId;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const WorkerVersionOutput = z.looseObject({
  id: z.string().nullish(),
  resources: z
    .looseObject({
      bindings: z.array(z.looseObject({ name: z.string(), type: z.string() })).nullish(),
    })
    .nullish(),
  bindings: z.array(z.looseObject({ name: z.string(), type: z.string() })).nullish(),
});

/**
 * The bindings of the Worker's latest version as the API stores them
 * (`queue_name`, `index_name`, `json`, …; the types with underscores,
 * `analytics_engine`, `send_email`): `cf workers versions get latest`,
 * since `cf workers get` carries none.
 */
export async function readWorkerBindings(
  live: LiveAccount,
  workerName: string,
): Promise<Array<Record<string, unknown> & { name: string; type: string }>> {
  const version = await runCfJson(
    live.cf,
    { plane: "account", args: ["workers", "versions", "get", "latest", "--worker-id", workerName] },
    WorkerVersionOutput,
  );
  return version.bindings ?? version.resources?.bindings ?? [];
}

/** Delete the Worker if it exists (with what references it); nothing when it doesn't. */
export async function deleteWorkerQuietly(live: LiveAccount, workerName: string): Promise<boolean> {
  if (!(await getWorkerDeployment(live.cf, workerName))) return false;
  try {
    await deleteWorker(live.cf, workerName, { withReferences: true });
    return true;
  } catch (error) {
    if (isCfError(error, "not_found")) return false;
    throw error;
  }
}
