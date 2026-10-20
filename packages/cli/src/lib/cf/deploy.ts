/**
 * Uploading a prebuilt Build Output with `cf deploy --prebuilt`.
 *
 * Secrets travel only in `--secrets-file` (a private temp file), so they ship
 * in the same Worker version as the code. cf's output stays in memory (a
 * failure carries its message) unless --verbose attaches cf to a person's
 * terminal: then cf shows it and asks its own questions (a Worker last
 * changed in the dashboard or through the API, a DNS record or Custom
 * Domain held by something else). Piped, cf takes over hostnames without
 * asking (../domains/preflight.ts warns first), and aborts before uploading
 * over a Worker changed outside everyapp: at a terminal, it then runs again
 * attached to ask. Unattended runs can't answer: cf aborts, and this says
 * what to do.
 */
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { isInterrupted, onInterrupt } from "@/lib/interrupt";
import { thisCommand } from "@/lib/output/command";
import { confirmAtTerminal, confirmOrCancel, type Confirm } from "@/lib/output/prompt";
import { CfError, isCfError } from "./errors";
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
  /** A person at the terminal can answer cf's questions. */
  interactive: boolean;
  /** With `interactive`, run cf attached to the terminal: it shows its output and asks its own questions. */
  attach: boolean;
  dryRun?: boolean;
  /** Deploy with the CLI's own cf: `cwd` is a gateway release, not an app. */
  cliCf?: boolean;
  /**
   * Upload this Worker of the Build Output (an app's helper Worker) rather
   * than its default one; it is `workerName` too.
   */
  buildOutputWorker?: string;
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
  const attached = options.interactive && options.attach && !options.dryRun;
  const deploy = (mode: "interactive" | "text") =>
    options.cf.run({
      plane: "project",
      cwd: options.cwd,
      cliCf: options.cliCf,
      mode,
      timeoutMs: DEPLOY_TIMEOUT_MS,
      ...(secrets ? { files: { "secrets.json": secrets } } : {}),
      args: (files) => [
        "deploy",
        "--prebuilt",
        "--mode",
        "production",
        "--message",
        options.message,
        ...(options.buildOutputWorker
          ? ["--worker", options.buildOutputWorker]
          : []),
        ...(secrets ? ["--secrets-file", files["secrets.json"]!] : []),
        ...(options.dryRun ? ["--dry-run"] : []),
      ],
    });
  let output: string;
  try {
    const result = await deploy(attached ? "interactive" : "text").catch(
      (error: unknown) => {
        // Piped, cf can't ask before replacing a Worker changed outside
        // everyapp and aborts before uploading: a person is asked attached.
        if (options.interactive && isCfError(error, "strict_conflict")) {
          return deploy("interactive");
        }
        throw error;
      },
    );
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
      `cf finished without uploading a new version of ${options.workerName}\nWas one of its questions answered no? The version that was serving still is.`,
      { rerun: thisCommand(), rerunNote: "to deploy again" },
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
 * while nothing has changed, in the command's own words (`change`); No
 * cancels the run.
 */
export async function assertReplaceable({
  cf,
  workerName,
  shownAs,
  recordedVersionIds,
  interactive,
  confirm = confirmAtTerminal,
  change,
}: {
  cf: CfRunner;
  workerName: string;
  /** The Worker as a person knows it: "analytics", "the Gateway". */
  shownAs: string;
  /** The versions everyapp recorded uploading (registry, install row, own record). */
  recordedVersionIds: ReadonlyArray<string | null | undefined>;
  interactive: boolean;
  confirm?: Confirm;
  /**
   * What this run would do to it: the question ("Set GITHUB_TOKEN on it
   * anyway?") and what saying yes does ("Setting GITHUB_TOKEN creates a new
   * version from it.").
   */
  change: { question: string; effect?: string };
}): Promise<void> {
  const serving = await getWorkerDeployment(cf, workerName);
  if (!serving) return;
  if (serving.versionId && recordedVersionIds.includes(serving.versionId)) return;
  if (!interactive) {
    throw new ActionRequiredError(
      "rerun_interactive",
      `${withCapitalThe(shownAs)} was changed outside everyapp; confirm in a terminal\nIts live version wasn't deployed by everyapp, and Cloudflare won't replace it unattended. Nothing changed.`,
      undefined,
      { rerunNote: "in a terminal", data: { workerName, versionId: serving.versionId } },
    );
  }
  await confirmOrCancel(confirm, change.question, {
    context: [
      `${withCapitalThe(shownAs)}'s live version wasn't deployed by everyapp (dashboard, API, or an interrupted deploy).`,
      [change.effect, "Cloudflare may ask to confirm again."].filter(Boolean).join(" "),
    ],
  });
}

/** Where an account subscribes to Workers Paid. */
export function workersPlansUrl(accountId: string): string {
  return `https://dash.cloudflare.com/${accountId}/workers/plans`;
}

/** "the Gateway" starts a sentence as "The Gateway"; an app id stays as it is. */
const withCapitalThe = (text: string) => text.replace(/^the /, "The ");

function explainDeployFailure(
  error: unknown,
  { workerName, accountId }: CfDeployOptions,
): unknown {
  if (!(error instanceof CfError)) return error;
  if (error.kind === "strict_conflict") {
    return new ActionRequiredError(
      "rerun_interactive",
      `${workerName} was changed outside everyapp; confirm in a terminal\nIt was last changed in the Cloudflare dashboard or through the API, so cf won't overwrite it unattended.`,
      undefined,
      { rerunNote: "in a terminal, and confirm cf's prompt" },
    );
  }
  if (error.kind === "subdomain_missing") {
    return new ActionRequiredError(
      "register_workers_subdomain",
      "Choose a workers.dev subdomain for this Cloudflare account\nCloudflare needs one before an account's first Worker. Apps never use it.",
      error.message.match(/https:\/\/dash\.cloudflare\.com\/\S+/)?.[0] ??
        `https://dash.cloudflare.com/${accountId}/workers/onboarding`,
    );
  }
  if (error.kind === "free_plan") {
    return new ActionRequiredError(
      "upgrade_workers_paid",
      "Subscribe this account to Workers Paid\nCloudflare refused the upload on the Free plan. Every App needs Workers Paid ($5 a month, then usage).",
      workersPlansUrl(accountId),
      { data: { workerName, cloudflare: error.message } },
    );
  }
  return error;
}
