/**
 * `everyapp app workflows …`: the deployed app's Workflows, through
 * `cf workflows` in the gateway's Cloudflare account, with your Cloudflare
 * login. Name a Workflow by its binding in everyapp.config.ts
 * (`RANK_CHECK`), its class, or its full name; only a Workflow that runs on
 * the app's own Worker is touched. Locally, `everyapp dev` points at cf
 * dev's Local Explorer, which does the same for the Workflows it runs.
 */
import type { LocalContext } from "@/context";
import { appWorkflows, type AppWorkflow } from "@/lib/app/workflows";
import { canPromptInTerminal, confirmAtTerminal, type Confirm } from "@/lib/cf/deploy";
import { createCfRunner, runCfJson, type CfRunner } from "@/lib/cf/runner";
import {
  WorkflowInstanceCreatedOutput,
  WorkflowInstanceListOutput,
  WorkflowInstanceOutput,
  WorkflowStatusOutput,
} from "@/lib/cf/schemas";
import { getWorkflow } from "@/lib/cf/workflows";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { readApp } from "@/lib/gateway/registry";
import { loadEveryAppManifest } from "@/lib/manifest";
import { eventSink, runReported } from "@/lib/output/run";

interface WorkflowFlags {
  gateway?: string;
  "account-id"?: string;
  json?: boolean;
}

/** Where a command runs; tests swap cf and the terminal. */
interface WorkflowCommandOptions {
  cwd: string;
  /** The gateway `--gateway` or EVERYAPP_GATEWAY_URL names. */
  gateway?: string;
  /** The Gateway's Cloudflare account (`--account-id`). */
  accountId?: string;
  json?: boolean;
  interactive?: boolean;
  createCf?: (accountId?: string) => CfRunner;
}

type StatusChange = "pause" | "resume" | "terminate" | "restart";

type InstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting"
  | "waitingForPause"
  | "errored"
  | "terminated"
  | "complete"
  | "rollingBack";

const DONE: Record<StatusChange, string> = {
  pause: "Paused",
  resume: "Resumed",
  terminate: "Terminated",
  restart: "Restarted",
};

/** The app's Workflows and cf pinned to the gateway's account. */
async function connect({
  cwd,
  gateway,
  accountId,
  json,
  interactive = canPromptInTerminal(json ?? false),
  createCf = (accountId?: string) => createCfRunner({ accountId }),
}: WorkflowCommandOptions): Promise<{
  cf: CfRunner;
  workerName: string;
  workflows: AppWorkflow[];
}> {
  const manifest = await loadEveryAppManifest(cwd);
  if (!manifest.resources?.workflows?.length) {
    throw new EveryAppError(
      "NO_WORKFLOWS",
      "everyapp.config.ts declares no Workflows (resources.workflows).",
    );
  }
  const { cf, db } = await connectToGateway({
    gateway,
    accountId,
    interactive,
    createCf,
  });
  const { workerName } = await readApp(db, manifest.id);
  return {
    cf,
    workerName,
    workflows: appWorkflows(workerName, manifest),
  };
}

/** One of the app's deployed Workflows, by binding, class or name. */
async function openWorkflow(
  options: WorkflowCommandOptions,
  name: string,
): Promise<{ cf: CfRunner; workflow: AppWorkflow }> {
  const { cf, workerName, workflows } = await connect(options);
  const workflow = workflows.find((candidate) =>
    [candidate.binding, candidate.className, candidate.name].includes(name),
  );
  if (!workflow) {
    throw new EveryAppError(
      "WORKFLOW_NOT_FOUND",
      `everyapp.config.ts declares no Workflow ${name}; it declares ${workflows.map((candidate) => candidate.binding).join(", ")}.`,
    );
  }
  const deployed = await getWorkflow(cf, workflow.name);
  if (deployed?.script_name !== workerName) {
    throw new EveryAppError(
      "WORKFLOW_NOT_DEPLOYED",
      deployed
        ? `${workflow.name} runs on Worker ${deployed.script_name ?? "(unknown)"}, not the app's ${workerName}.`
        : `${workflow.name} doesn't exist yet; deploy the app first (everyapp app deploy).`,
    );
  }
  return { cf, workflow };
}

/** Each Workflow the app declares, with its instances' counts once deployed. */
export async function listAppWorkflows(options: WorkflowCommandOptions) {
  const { cf, workerName, workflows } = await connect(options);
  const listed = [];
  for (const workflow of workflows) {
    const found = await getWorkflow(cf, workflow.name);
    const deployed = found?.script_name === workerName ? found : null;
    listed.push({
      ...workflow,
      deployed: deployed !== null,
      instances: deployed ? (deployed.instances ?? {}) : null,
    });
  }
  return listed;
}

export async function listInstances(
  options: WorkflowCommandOptions & {
    workflow: string;
    status?: InstanceStatus;
    limit?: number;
  },
) {
  const { cf, workflow } = await openWorkflow(options, options.workflow);
  return runCfJson(
    cf,
    {
      plane: "account",
      args: [
        "workflows",
        "instances",
        "list",
        "--workflow-name",
        workflow.name,
        "--per-page",
        String(options.limit ?? 25),
        ...(options.status ? ["--status", options.status] : []),
      ],
    },
    WorkflowInstanceListOutput,
  );
}

async function getInstance(
  options: WorkflowCommandOptions & { workflow: string; instanceId: string },
) {
  const { cf, workflow } = await openWorkflow(options, options.workflow);
  return runCfJson(
    cf,
    {
      plane: "account",
      args: [
        "workflows",
        "instances",
        "get",
        options.instanceId,
        "--workflow-name",
        workflow.name,
      ],
    },
    WorkflowInstanceOutput,
  );
}

export async function startInstance(
  options: WorkflowCommandOptions & {
    workflow: string;
    params?: string;
    instanceId?: string;
  },
) {
  if (options.params !== undefined) {
    try {
      JSON.parse(options.params);
    } catch {
      throw new EveryAppError(
        "INVALID_PARAMS",
        `--params must be JSON, e.g. '{"siteId":"abc"}'.`,
      );
    }
  }
  const { cf, workflow } = await openWorkflow(options, options.workflow);
  const created = await runCfJson(
    cf,
    {
      plane: "account",
      args: [
        "workflows",
        "instances",
        "create",
        workflow.name,
        ...(options.params !== undefined ? ["--params", options.params] : []),
        ...(options.instanceId ? ["--instance-id", options.instanceId] : []),
      ],
    },
    WorkflowInstanceCreatedOutput,
  );
  return { workflow, instance: created };
}

/**
 * Pause, resume, terminate or restart an instance. Terminating is for
 * good, so at a terminal it asks first; unattended it needs `--yes`.
 */
export async function changeInstanceStatus(
  options: WorkflowCommandOptions & {
    workflow: string;
    instanceId: string;
    status: StatusChange;
    yes?: boolean;
    confirm?: Confirm;
  },
) {
  const { cf, workflow } = await openWorkflow(options, options.workflow);
  if (options.status === "terminate" && !options.yes) {
    if (!(options.interactive ?? canPromptInTerminal(options.json ?? false))) {
      throw new EveryAppError(
        "CONFIRMATION_REQUIRED",
        "Terminating an instance needs a person at a terminal, or --yes.",
      );
    }
    const confirmed = await (options.confirm ?? confirmAtTerminal)(
      `Terminate instance ${options.instanceId} of ${workflow.binding}? It stops for good.`,
    );
    if (!confirmed) {
      throw new EveryAppError(
        "TERMINATE_CANCELLED",
        `Left instance ${options.instanceId} running.`,
      );
    }
  }
  const changed = await runCfJson(
    cf,
    {
      plane: "account",
      args: [
        "workflows",
        "instances",
        options.status,
        options.instanceId,
        "--workflow-name",
        workflow.name,
        "--status",
        options.status,
        // cf's own question; answered above.
        ...(options.status === "terminate" ? ["--force"] : []),
      ],
    },
    WorkflowStatusOutput,
  );
  return { workflow, status: changed.status ?? null };
}

async function commandOptions(flags: WorkflowFlags): Promise<WorkflowCommandOptions> {
  return {
    cwd: process.cwd(),
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    json: flags.json,
  };
}

export async function list(this: LocalContext, flags: WorkflowFlags): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, async () => {
    const workflows = await listAppWorkflows(await commandOptions(flags));
    out.emit({
      type: "done",
      message: workflows
        .map(
          (workflow) =>
            `${workflow.binding} (${workflow.className}) ${workflow.name}: ${
              workflow.instances ? countInstances(workflow.instances) : "not deployed yet"
            }`,
        )
        .join("\n"),
      data: { workflows },
    });
  });
}

export async function instances(
  this: LocalContext,
  flags: WorkflowFlags & { status?: InstanceStatus; limit?: number },
  workflow: string,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, async () => {
    const listed = await listInstances({
      ...(await commandOptions(flags)),
      workflow,
      status: flags.status,
      limit: flags.limit,
    });
    out.emit({
      type: "done",
      message:
        listed
          .map((instance) =>
            [instance.id, instance.status, instance.created_on]
              .filter(Boolean)
              .join("  "),
          )
          .join("\n") || "No instances.",
      data: { instances: listed },
    });
  });
}

export async function get(
  this: LocalContext,
  flags: WorkflowFlags,
  workflow: string,
  instanceId: string,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, async () => {
    const instance = await getInstance({
      ...(await commandOptions(flags)),
      workflow,
      instanceId,
    });
    out.emit({
      type: "done",
      message: JSON.stringify(instance, null, 2),
      data: { instance },
    });
  });
}

export async function start(
  this: LocalContext,
  flags: WorkflowFlags & { params?: string; id?: string },
  workflow: string,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, async () => {
    const started = await startInstance({
      ...(await commandOptions(flags)),
      workflow,
      params: flags.params,
      instanceId: flags.id,
    });
    out.emit({
      type: "done",
      message: `Started instance ${started.instance.id} of ${started.workflow.binding}.`,
      data: { workflow: started.workflow.name, instance: started.instance },
    });
  });
}

async function reportStatusChange(
  flags: WorkflowFlags & { yes?: boolean },
  change: { workflow: string; instanceId: string; status: StatusChange },
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, async () => {
    const changed = await changeInstanceStatus({
      ...(await commandOptions(flags)),
      ...change,
      yes: flags.yes,
    });
    out.emit({
      type: "done",
      message: `${DONE[change.status]} instance ${change.instanceId} of ${changed.workflow.binding}${changed.status ? ` (${changed.status})` : ""}.`,
      data: {
        workflow: changed.workflow.name,
        instanceId: change.instanceId,
        status: changed.status,
      },
    });
  });
}

function statusCommand(status: Exclude<StatusChange, "terminate">) {
  return async function (
    this: LocalContext,
    flags: WorkflowFlags,
    workflow: string,
    instanceId: string,
  ): Promise<void> {
    await reportStatusChange(flags, { workflow, instanceId, status });
  };
}

export const pause = statusCommand("pause");
export const resume = statusCommand("resume");
export const restart = statusCommand("restart");

export async function terminate(
  this: LocalContext,
  flags: WorkflowFlags & { yes?: boolean },
  workflow: string,
  instanceId: string,
): Promise<void> {
  await reportStatusChange(flags, { workflow, instanceId, status: "terminate" });
}

/** "2 running, 40 complete": the non-zero counts. */
function countInstances(counts: Record<string, number>): string {
  const nonZero = Object.entries(counts).filter(([, count]) => count > 0);
  return nonZero.length > 0
    ? nonZero.map(([status, count]) => `${count} ${status}`).join(", ")
    : "no instances";
}
