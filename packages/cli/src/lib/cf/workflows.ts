/**
 * Workflows through `cf workflows`. cf creates and updates a Worker's own
 * Workflows when it deploys the Worker (`PUT /workflows/<name>`, which
 * reassigns a name another Worker holds); these read and delete them.
 */
import { CfError } from "./errors";
import { listAll } from "./resources";
import { runCfJson, type CfRunner } from "./runner";
import { WorkflowListOutput, WorkflowOutput, type Workflow } from "./schemas";

const PAGE_SIZE = 100;

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
    if (error instanceof CfError && error.kind === "not_found") return null;
    throw error;
  }
}

/** The account's Workflows whose names contain `search`. */
export function listWorkflows(cf: CfRunner, search: string): Promise<Workflow[]> {
  return listAll(
    cf,
    ["workflows", "list", "--search", search],
    WorkflowListOutput,
    PAGE_SIZE,
  );
}

/**
 * Delete a Workflow with its instances. `--force` answers cf's
 * confirmation, decided as for `deleteD1`.
 */
export async function deleteWorkflow(cf: CfRunner, name: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["workflows", "delete", name, "--force"],
  });
}
