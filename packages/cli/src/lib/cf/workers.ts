/**
 * What is deployed to a Worker, read with `cf workers deployments list`
 * (by script name), and deleting one.
 */
import { isCfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import { WorkerDeploymentsOutput } from "./schemas";

interface WorkerDeployment {
  /** The version serving the largest share of traffic. */
  versionId: string | null;
  /** When that deployment went out (ms), when cf says. */
  deployedAt: number | null;
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
  };
}

/**
 * Delete a Worker with its versions and deployments. `--force` answers cf's
 * confirmation, decided as for `deleteD1`.
 */
export async function deleteWorker(
  cf: CfRunner,
  workerName: string,
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["workers", "delete", workerName, "--force"],
  });
}
