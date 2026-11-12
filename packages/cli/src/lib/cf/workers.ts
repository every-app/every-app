/**
 * What is deployed to a Worker, read with `cf workers deployments list`
 * (by script name), the account's Workers with their Custom Domains
 * (`cf workers list`), and deleting one.
 */
import { isCfError } from "./errors";
import { listAll, runCfJson, type CfRunner } from "./runner";
import { WorkerDeploymentsOutput, WorkerListOutput, type ListedWorker } from "./schemas";

const PAGE = { perPage: 100, maxPages: 50 };

/** Every Worker in the account, each with the Custom Domains that reference it. */
export function listWorkers(cf: CfRunner): Promise<ListedWorker[]> {
  return listAll(cf, ["workers", "list"], WorkerListOutput, PAGE);
}

/**
 * The hostnames that are Custom Domains of `workerName` (lower-cased), from
 * the account's Workers; none when there is no such Worker.
 */
export async function workerCustomDomains(
  cf: CfRunner,
  workerName: string,
): Promise<string[]> {
  const workers = await listWorkers(cf);
  return (workers.find((worker) => worker.name === workerName)?.references?.domains ?? []).map(
    (domain) => domain.hostname.toLowerCase(),
  );
}

/** Why Cloudflare made a version, where everyapp tells them apart (`workers/triggered_by`). */
export enum DeploymentTrigger {
  Secret = "secret",
  Rollback = "rollback",
}

export interface WorkerDeployment {
  /** The version serving the largest share of traffic. */
  versionId: string | null;
  /** When that deployment went out (ms), when cf says. */
  deployedAt: number | null;
  /** Who made it, as Cloudflare says. */
  author: string | null;
  /** What made it: `dash`, `api`, `wrangler`, `cf_cli`. */
  source: string | null;
  /** Why: `deployment`, `upload`, `secret`, `rollback`. */
  triggeredBy: string | null;
  /** The deploy's message (everyapp's: "everyapp 0.3.0 gateway 0.3.0 (upgrade)"). */
  message: string | null;
}

/**
 * The Worker's current deployment, or null when no Worker has that name
 * (a first deploy).
 */
export async function getWorkerDeployment(
  cf: CfRunner,
  workerName: string,
): Promise<WorkerDeployment | null> {
  let deployments;
  try {
    deployments = await runCfJson(
      cf,
      {
        plane: "account",
        args: [
          "workers",
          "deployments",
          "list",
          "--worker",
          workerName,
          "--per-page",
          "10",
        ],
      },
      WorkerDeploymentsOutput,
    );
  } catch (error) {
    if (isCfError(error, "not_found")) return null;
    throw error;
  }
  const newest = [...deployments].sort((a, b) =>
    (b.created_on ?? "").localeCompare(a.created_on ?? ""),
  )[0];
  const version = [...(newest?.versions ?? [])].sort(
    (a, b) => b.percentage - a.percentage,
  )[0];
  return {
    versionId: version?.version_id ?? null,
    deployedAt: newest?.created_on ? Date.parse(newest.created_on) : null,
    author: newest?.author_email ?? null,
    source: newest?.source ?? null,
    triggeredBy: newest?.annotations?.["workers/triggered_by"] ?? null,
    message: newest?.annotations?.["workers/message"] ?? null,
  };
}

/**
 * Delete a Worker with its versions and deployments. `--force` answers cf's
 * confirmation, decided as for `deleteD1`. The API refuses a Worker another
 * Worker still binds unless asked to delete it anyway (`withReferences`:
 * `--delete-with-references`, the API's `force`): the teardown asks, since
 * the Gateway and the apps bind each other and every one of them goes.
 */
export async function deleteWorker(
  cf: CfRunner,
  workerName: string,
  { withReferences = false }: { withReferences?: boolean } = {},
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: [
      "workers",
      "delete",
      workerName,
      "--force",
      ...(withReferences ? ["--delete-with-references"] : []),
    ],
  });
}
