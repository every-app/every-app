/**
 * Cloudflare Artifacts namespaces through `cf artifacts namespaces`, for
 * `delete --purge`: a namespace's repos, then the namespace. The deploy
 * makes nothing here (Artifacts creates a namespace with its first repo).
 * Written against cf@1.0.0-beta.14's command list and Cloudflare's
 * OpenAPI spec on 2026-11-01, not yet seen live: `repos list` prints the
 * API's `result` (an array of repos), `repos delete` answers 202 and
 * schedules the repo's data for cleanup, and `namespaces delete` deletes
 * only an empty namespace. `--force` answers cf's confirmation, as for
 * every other delete here (lib/cf/resources.ts deleteD1): callers decide
 * first, on a namespace the ledger records as the app's.
 */
import { isCfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import { ArtifactsRepoListOutput } from "./schemas";

/**
 * Whether the namespace exists: Artifacts makes one with its first repo,
 * so one that does was made by something, which the deploy won't adopt
 * unless the ledger already records it as the app's.
 */
export async function findArtifactsNamespace(cf: CfRunner, namespace: string): Promise<boolean> {
  try {
    await cf.run({ plane: "account", mode: "json", args: ["artifacts", "namespaces", "get", namespace] });
    return true;
  } catch (error) {
    if (isCfError(error, "not_found")) return false;
    throw error;
  }
}

/** The most repos one list call returns (Cloudflare's maximum). */
const PAGE_SIZE = 200;

/** The names of up to {@link PAGE_SIZE} repos in a namespace. */
function listArtifactsRepos(cf: CfRunner, namespace: string): Promise<string[]> {
  return runCfJson(
    cf,
    {
      plane: "account",
      args: [
        "artifacts",
        "namespaces",
        "repos",
        "list",
        "--namespace",
        namespace,
        "--limit",
        String(PAGE_SIZE),
      ],
    },
    ArtifactsRepoListOutput,
  ).then((repos) => repos.map((repo) => repo.name));
}

/** Delete one repo and its git data. */
async function deleteArtifactsRepo(
  cf: CfRunner,
  namespace: string,
  name: string,
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["artifacts", "namespaces", "repos", "delete", name, "--namespace", namespace, "--force"],
  });
}

/** Delete a namespace; Cloudflare refuses one that still holds repos. */
async function deleteArtifactsNamespace(cf: CfRunner, namespace: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["artifacts", "namespaces", "delete", namespace, "--force"],
  });
}

/**
 * Every repo in a namespace, then the namespace: the names of the repos
 * deleted. Lists again after each page, since a deleted repo leaves the
 * list (cf prints no cursor); stops when a page holds only repos already
 * deleted, so a list that lags can't loop. A namespace that was never
 * made (no repo was ever created) or is gone is fine: `not_found` is
 * thrown for the caller to treat as deleted.
 */
export async function purgeArtifactsNamespace(cf: CfRunner, namespace: string): Promise<string[]> {
  const deleted = new Set<string>();
  for (;;) {
    const page = (await listArtifactsRepos(cf, namespace)).filter((name) => !deleted.has(name));
    if (page.length === 0) break;
    for (const name of page) {
      try {
        await deleteArtifactsRepo(cf, namespace, name);
      } catch (error) {
        // Deleted since the list, by hand or by an earlier purge.
        if (!isCfError(error, "not_found")) throw error;
      }
      deleted.add(name);
    }
  }
  await deleteArtifactsNamespace(cf, namespace);
  return [...deleted];
}
