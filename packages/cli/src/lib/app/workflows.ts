/**
 * An app's Workflows: its Worker defines each one in everyapp.config.ts
 * (`resources.workflows`), named after the Worker
 * (`every-acme-seo--rank-check`), and cf creates or updates it when it
 * deploys the Worker. Workflow names are account-wide, and cf's update
 * reassigns a name another Worker holds, so a deploy first makes sure each
 * name is free or already the app Worker's.
 */
import { ManifestSchema } from "@every-app/perimeter/manifest";
import { workflowNameFor } from "@every-app/sdk/cloudflare";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkflow } from "@/lib/cf/workflows";
import { EveryAppError } from "@/lib/errors";

export interface AppWorkflow {
  /** The manifest binding, e.g. RANK_CHECK. */
  binding: string;
  className: string;
  /** The Workflow's name in the account. */
  name: string;
}

interface DeclaresWorkflows {
  resources?: {
    workflows?: ReadonlyArray<{ name: string; className: string }>;
  };
}

/** The Workflows a manifest declares, named after `workerName`. */
export function appWorkflows(
  workerName: string,
  manifest: DeclaresWorkflows,
): AppWorkflow[] {
  return (manifest.resources?.workflows ?? []).map((workflow) => ({
    binding: workflow.name,
    className: workflow.className,
    name: workflowNameFor(workerName, workflow.name),
  }));
}

/**
 * Refuse a Workflow name another Worker runs: deploying would hand it, with
 * its instances, to the app's Worker.
 */
export async function assertOwnWorkflows({
  cf,
  workerName,
  names,
}: {
  cf: CfRunner;
  workerName: string;
  names: readonly string[];
}): Promise<void> {
  for (const name of names) {
    const existing = await getWorkflow(cf, name);
    if (existing && existing.script_name !== workerName) {
      throw new EveryAppError(
        "WORKFLOW_NAME_TAKEN",
        `A Workflow named "${name}" already exists in this Cloudflare account and runs on Worker ${existing.script_name ?? "(unknown)"}, not ${workerName}; deploying would take it over. Delete or rename it, then deploy again.`,
      );
    }
  }
}

/**
 * The Workflows the last deploy's manifest declared that this one doesn't,
 * among those that still run on the app's Worker.
 */
export async function droppedWorkflows({
  cf,
  workerName,
  previousManifest,
  names,
}: {
  cf: CfRunner;
  workerName: string;
  previousManifest: unknown;
  /** The Workflows this deploy keeps. */
  names: readonly string[];
}): Promise<AppWorkflow[]> {
  const previous = ManifestSchema.safeParse(previousManifest);
  if (!previous.success) return [];
  const dropped: AppWorkflow[] = [];
  for (const workflow of appWorkflows(workerName, previous.data)) {
    if (names.includes(workflow.name)) continue;
    // A first deploy that was refused registered a name another Worker runs.
    if ((await getWorkflow(cf, workflow.name))?.script_name === workerName) {
      dropped.push(workflow);
    }
  }
  return dropped;
}
