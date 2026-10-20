/**
 * Workflows through `cf workflows`. cf creates and updates a Worker's own
 * Workflows when it deploys the Worker (`PUT /workflows/<name>`, which
 * reassigns a name another Worker holds); these read and delete them.
 */
import { isCfError } from "./errors";
import { listAll, runCfJson, type CfRunner } from "./runner";
import { WorkflowListOutput, WorkflowOutput, type Workflow } from "./schemas";

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** The Workflow with this name, or null when the account has none. */
export async function getWorkflow(
  cf: CfRunner,
  name: string,
): Promise<Workflow | null> {
  try {
    return await runCfJson(
      cf,
      { plane: "account", args: ["workflows", "get", name] },
      WorkflowOutput,
    );
  } catch (error) {
    if (isCfError(error, "not_found")) return null;
    throw error;
  }
}

/** The account's Workflows whose names contain `search`. */
export function listWorkflows(cf: CfRunner, search: string): Promise<Workflow[]> {
  return listAll(
    cf,
    ["workflows", "list", "--search", search],
    WorkflowListOutput,
    { perPage: PAGE_SIZE, maxPages: MAX_PAGES },
  );
}

/**
 * Delete a Workflow with its instances. `--force` answers cf's
 * confirmation, decided as for `deleteD1`.
 */
async function deleteWorkflow(cf: CfRunner, name: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["workflows", "delete", name, "--force"],
  });
}

/** {@link deleteWorkflow}, unless it is gone already: whether it was there. */
export async function deleteWorkflowIfExists(cf: CfRunner, name: string): Promise<boolean> {
  try {
    await deleteWorkflow(cf, name);
    return true;
  } catch (error) {
    if (isCfError(error, "not_found")) return false;
    throw error;
  }
}
