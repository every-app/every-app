/**
 * Uploading a prebuilt Build Output with `cf deploy --prebuilt`.
 *
 * Secrets travel only in `--secrets-file` (a private temp file), so they ship
 * in the same Worker version as the code. A person at a terminal runs cf
 * attached to it and answers cf's own prompts: a Worker last changed in the
 * dashboard or through the API, a DNS record or Custom Domain held by
 * something else. Unattended runs can't answer them: cf aborts, and this
 * says what to do.
 */
import enquirer from "enquirer";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { isInterrupted, onInterrupt } from "@/lib/interrupt";
import { CfError } from "./errors";
import type { CfRunner } from "./runner";
import { getWorkerDeployment } from "./workers";

const DEPLOY_TIMEOUT_MS = 900_000;

interface CfDeployOptions {
  cf: CfRunner;
  /** The directory holding `.cloudflare/output/v0`. */
  cwd: string;
  workerName: string;
  accountId: string;
  message: string;
  secrets?: Record<string, string>;
  /** Run attached to the terminal, so cf can ask its questions. */
  interactive: boolean;
  dryRun?: boolean;
  /** Deploy with the CLI's own cf: `cwd` is a gateway release, not an app. */
  cliCf?: boolean;
  /**
   * Records the version uploaded, as soon as it is known, so the next
   * unattended deploy knows it was everyapp's (assertReplaceable): also on
   * the way out of a run interrupted once cf got that far, or one cf failed
   * after its upload. `finished` is whether cf ran to its end: it publishes
   * the Worker's routes and Custom Domains after the version goes live, and
   * stops part-way when it can't publish one (a move from another Worker
   * declined, the zone's limit, an API error, Ctrl+C), so until it finishes
   * only the version is known to be live.
   */
  onUploaded?: (versionId: string, finished: boolean) => Promise<void>;
}

interface CfDeployResult {
  /** The version now serving; null after a dry run. */
  versionId: string | null;
  /** cf's own output (empty when it ran attached to the terminal). */
  output: string;
}

/** Asks the person at the terminal a yes/no question; tests answer for them. */
export type Confirm = (question: string) => Promise<boolean>;

export const confirmAtTerminal: Confirm = async (message) =>
  (
    await enquirer.prompt<{ confirmed: boolean }>({
      type: "confirm",
      name: "confirmed",
      message,
      initial: false,
    })
  ).confirmed;

/** Whether a person is at this terminal to answer cf's prompts. */
export function canPromptInTerminal(json: boolean): boolean {
  return (
    Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
    !json &&
    !process.env["CI"]
  );
}

export async function cfDeploy(options: CfDeployOptions): Promise<CfDeployResult> {
  const secrets =
    options.secrets && Object.keys(options.secrets).length > 0
      ? options.secrets
      : undefined;
  const before = options.dryRun
    ? null
    : await getWorkerDeployment(options.cf, options.workerName);
  // Whether cf exited cleanly, its routes and Custom Domains published too.
  let finished = false;
  // Ctrl+C, or a cancelled CI job, while cf uploads: cf is stopped, and
  // with it this run, but what cf got live by then is still recorded.
  const forget =
    options.onUploaded && !options.dryRun
      ? onInterrupt({
          async: () => recordNewVersion(options, before, finished),
        })
      : undefined;
  try {
    return await deployAndRecord(options, secrets, before, () => {
      finished = true;
    });
  } catch (error) {
    // cf can fail after its upload went live (publishing a Custom Domain,
    // or the record itself): the version that went live is recorded all
    // the same.
    if (forget && !isInterrupted()) {
      await recordNewVersion(options, before, finished).catch(() => undefined);
    }
    throw error;
  } finally {
    // Once interrupted, recording is the interrupt's to do (its cf calls
    // run; any this run starts now is stopped).
    if (!isInterrupted()) forget?.();
  }
}

async function recordNewVersion(
  options: CfDeployOptions,
  before: { versionId: string | null } | null,
  finished: boolean,
): Promise<void> {
  const after = await getWorkerDeployment(options.cf, options.workerName);
  if (after?.versionId && after.versionId !== before?.versionId) {
    await options.onUploaded?.(after.versionId, finished);
  }
}

async function deployAndRecord(
  options: CfDeployOptions,
  secrets: Record<string, string> | undefined,
  before: { versionId: string | null } | null,
  onFinished: () => void,
): Promise<CfDeployResult> {
  let output: string;
  try {
    const result = await options.cf.run({
      plane: "project",
      cwd: options.cwd,
      cliCf: options.cliCf,
      mode: options.interactive && !options.dryRun ? "interactive" : "text",
      timeoutMs: DEPLOY_TIMEOUT_MS,
      ...(secrets ? { files: { "secrets.json": secrets } } : {}),
      args: (files) => [
        "deploy",
        "--prebuilt",
        "--mode",
        "production",
        "--message",
        options.message,
        ...(secrets ? ["--secrets-file", files["secrets.json"]!] : []),
        ...(options.dryRun ? ["--dry-run"] : []),
      ],
    });
    output = result.stdout;
  } catch (error) {
    throw explainDeployFailure(error, options);
  }
  onFinished();
  if (options.dryRun) return { versionId: null, output };

  // An attached run printed to the terminal; ask Cloudflare what went live.
  // cf exits 0 without uploading when a person declines one of its prompts
  // (or it gives up on a conflict), so the same version means nothing went.
  const deployment = await getWorkerDeployment(options.cf, options.workerName);
  if (
    !deployment?.versionId ||
    deployment.versionId === before?.versionId
  ) {
    throw new EveryAppError(
      "DEPLOY_NOT_UPLOADED",
      `cf finished without uploading a new version of ${options.workerName} (was one of its questions answered no?). The version that was serving still is; if this run migrated a database, it stays migrated. Run the command again to deploy, or roll the database back with the command printed with its bookmark.`,
    );
  }
  await options.onUploaded?.(deployment.versionId, true);
  return { versionId: deployment.versionId, output };
}

/**
 * cf won't replace a Worker that was last changed in the dashboard or
 * through the API (its strict mode) without a person confirming: unattended
 * it aborts at the upload, and at a terminal it asks then. Both come after
 * the database is migrated, and cf can't be asked beforehand. So, before
 * migrating, this asks whether the version serving is one everyapp recorded
 * deploying. If not, an unattended run stops, and a person is asked now,
 * while nothing has changed.
 */
export async function assertReplaceable({
  cf,
  workerName,
  recordedVersionIds,
  interactive,
  confirm = confirmAtTerminal,
  note,
}: {
  cf: CfRunner;
  workerName: string;
  /** The versions everyapp recorded uploading (registry, install row, own record). */
  recordedVersionIds: ReadonlyArray<string | null | undefined>;
  interactive: boolean;
  confirm?: Confirm;
  /** What else replacing it could mean, for the person asked. */
  note?: string;
}): Promise<void> {
  const serving = await getWorkerDeployment(cf, workerName);
  if (!serving) return;
  if (serving.versionId && recordedVersionIds.includes(serving.versionId)) return;
  const what = `${workerName} is serving a version everyapp didn't record deploying: changed in the Cloudflare dashboard or through the API, deployed before everyapp used cf, or uploaded by a deploy that stopped before it could record it.${note ? ` ${note}` : ""}`;
  if (!interactive) {
    throw new ActionRequiredError(
      "rerun_interactive",
      `${what} It isn't replaced unattended (cf refuses to replace one changed in the dashboard or through the API, and can't be asked first), so nothing was migrated or uploaded: run this command once in a terminal.`,
    );
  }
  if (!(await confirm(`${what} Replace it? Any migrations run first, and cf may ask again.`))) {
    throw new EveryAppError(
      "DEPLOY_CANCELLED",
      `Left ${workerName} as it is: nothing was migrated or uploaded.`,
    );
  }
}

function explainDeployFailure(
  error: unknown,
  { workerName, accountId }: CfDeployOptions,
): unknown {
  if (!(error instanceof CfError)) return error;
  if (error.kind === "strict_conflict") {
    return new ActionRequiredError(
      "rerun_interactive",
      `${workerName} was last changed outside everyapp (in the Cloudflare dashboard or through the API), so cf won't overwrite it unattended. If this run migrated a database, it stays migrated. Run this command again in a terminal and confirm cf's prompt.`,
    );
  }
  if (error.kind === "subdomain_missing") {
    return new ActionRequiredError(
      "register_workers_subdomain",
      "This Cloudflare account has no workers.dev subdomain yet, and Cloudflare wants one before the first Worker upload and for Workflows. Pick one in the dashboard (apps stay private; they never use it), then run this command again.",
      error.message.match(/https:\/\/dash\.cloudflare\.com\/\S+/)?.[0] ??
        `https://dash.cloudflare.com/${accountId}/workers/onboarding`,
    );
  }
  return error;
}
