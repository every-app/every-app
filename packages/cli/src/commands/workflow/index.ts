/**
 * `everyapp workflow …`: the deployed app's Workflows, through
 * `cf workflows` in the gateway's Cloudflare account, with your Cloudflare
 * login. Name a Workflow by its binding in everyapp.config.ts
 * (`RANK_CHECK`), its class, or its full name; only a Workflow that runs on
 * the app's own Worker is touched. Locally, `everyapp dev` points at cf
 * dev's Local Explorer, which does the same for the Workflows it runs.
 */
import chalk from "chalk";
import { closeTo } from "@/argumentErrors";
import type { LocalContext } from "@/context";
import { appWorkflows, type AppWorkflow } from "@/lib/app/workflows";
import type { D1Database } from "@/lib/cf/d1";
import { runCfJson, type CfRunner } from "@/lib/cf/runner";
import {
  WorkflowInstanceCreatedOutput,
  WorkflowInstanceListOutput,
  WorkflowInstanceOutput,
  WorkflowStatusOutput,
} from "@/lib/cf/schemas";
import { getWorkflow } from "@/lib/cf/workflows";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { appIdOfWorker, readApp } from "@/lib/gateway/registry";
import { loadEveryAppManifest, type EveryAppCliManifest } from "@/lib/manifest";
import { CLI, thisCommand } from "@/lib/output/command";
import { ticked, type EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmUnlessYes, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts, formatTable } from "@/lib/output/table";
import { duration, roughly } from "@/lib/output/time";
import type { GatewayCommandFlags } from "../flags";
import { INSTANCE_STATUSES } from "./command";

/** Where a command runs; tests swap cf and the terminal. */
interface WorkflowCommandOptions {
  cwd: string;
  /** The gateway `--gateway` or EVERYAPP_GATEWAY_URL names. */
  gateway?: string;
  /** The Gateway's Cloudflare account (`--account-id`). */
  accountId?: string;
  json?: boolean;
  /** Steps and cf's device login (under --json the run waits for it). */
  out?: EventSink;
  interactive?: boolean;
  createCf?: (accountId?: string) => CfRunner;
}

enum StatusChange {
  Pause = "pause",
  Resume = "resume",
  Terminate = "terminate",
  Restart = "restart",
}

/** An instance status as Cloudflare names it. */
type InstanceStatus = (typeof INSTANCE_STATUSES)[keyof typeof INSTANCE_STATUSES];

/** How each change reads once done, and the status it leaves the instance in (not repeated). */
const CHANGED: Record<StatusChange, { done: string; doing: string; leaves: string }> = {
  [StatusChange.Pause]: { done: "Paused", doing: "Pausing", leaves: "paused" },
  [StatusChange.Resume]: { done: "Resumed", doing: "Resuming", leaves: "running" },
  [StatusChange.Terminate]: { done: "Terminated", doing: "Terminating", leaves: "terminated" },
  [StatusChange.Restart]: { done: "Restarted", doing: "Restarting", leaves: "" },
};

/** The app's manifest, refused when it declares no Workflows. */
async function manifestWithWorkflows(cwd: string): Promise<EveryAppCliManifest> {
  const manifest = await loadEveryAppManifest(cwd);
  if (!manifest.resources?.workflows?.length) {
    throw new EveryAppError("NO_WORKFLOWS", `${manifest.id} declares no Workflows`, {
      fix: "add one under resources.workflows in everyapp.config.ts",
    });
  }
  return manifest;
}

/** The app's Workflows, and cf pinned to the gateway's account. */
async function connect(
  { gateway, accountId, json, out, interactive = canPromptInTerminal(json ?? false), createCf }: WorkflowCommandOptions,
  manifest: EveryAppCliManifest,
): Promise<{ cf: CfRunner; db: D1Database; workflows: AppWorkflow[] }> {
  const { cf, db } = await connectToGateway({
    gateway,
    accountId,
    interactive,
    login: out && { json, out, step: "login" },
    createCf,
  });
  const { workerName } = await readApp(db, manifest.id);
  return { cf, db, workflows: appWorkflows(workerName, manifest) };
}

/** One of the app's deployed Workflows, by binding, class or name. */
async function openWorkflow(
  options: WorkflowCommandOptions,
  manifest: EveryAppCliManifest,
  name: string,
): Promise<{ cf: CfRunner; workflow: AppWorkflow }> {
  const { cf, db, workflows } = await connect(options, manifest);
  const workflow = workflows.find((candidate) =>
    [candidate.binding, candidate.className, candidate.name].includes(name),
  );
  if (!workflow) {
    const bindings = workflows.map((candidate) => candidate.binding);
    const match =
      bindings.find((binding) => binding.toLowerCase().startsWith(name.toLowerCase())) ??
      closeTo(name, bindings);
    throw new EveryAppError(
      "WORKFLOW_NOT_FOUND",
      `No Workflow ${name} in everyapp.config.ts\nIt declares ${bindings.join(", ")}.`,
      {
        ...(match
          ? { rerun: thisCommand([], process.argv.slice(2).map((arg) => (arg === name ? match : arg))) }
          : {}),
        data: { workflow: name, declared: bindings },
      },
    );
  }
  const deployed = await getWorkflow(cf, workflow.name);
  if (!deployed) {
    throw new EveryAppError(
      "WORKFLOW_NOT_DEPLOYED",
      `${workflow.binding} isn't deployed yet\nIt's created when ${manifest.id} deploys.`,
      { rerun: `${CLI} deploy`, data: { workflow: workflow.name } },
    );
  }
  if (deployed.script_name !== workflow.worker) {
    const holder = deployed.script_name ? await appIdOfWorker(db, deployed.script_name) : null;
    throw new EveryAppError(
      "WORKFLOW_NOT_DEPLOYED",
      holder
        ? `${workflow.binding} is attached to another app (${holder})\nCloudflare runs this Workflow on ${holder}'s Worker, not ${manifest.id}'s.`
        : `${workflow.binding} is attached to another Worker\nCloudflare runs this Workflow on a Worker that isn't ${manifest.id}'s.`,
      {
        fix: `delete that Workflow, or rename the binding in everyapp.config.ts, then deploy ${manifest.id}`,
        data: { workflow: workflow.name, scriptName: deployed.script_name ?? null, app: holder },
      },
    );
  }
  return { cf, workflow };
}

/** Each Workflow the app declares, with its instances' counts once deployed; none when it declares none. */
export async function listAppWorkflows(options: WorkflowCommandOptions) {
  const manifest = await loadEveryAppManifest(options.cwd);
  if (!manifest.resources?.workflows?.length) return { appId: manifest.id, workflows: [] };
  options.out?.emit({
    type: "step",
    step: "workflow.list",
    status: "start",
    message: `Listing ${manifest.id}'s Workflows...`,
  });
  const { cf, workflows } = await connect(options, manifest);
  const listed = [];
  for (const { worker, ...workflow } of workflows) {
    const found = await getWorkflow(cf, workflow.name);
    const deployed = found?.script_name === worker ? found : null;
    listed.push({
      ...workflow,
      deployed: deployed !== null,
      instances: deployed ? (deployed.instances ?? {}) : null,
    });
  }
  options.out?.emit({ type: "step", step: "workflow.list", status: "ok" });
  return { appId: manifest.id, workflows: listed };
}

export async function listInstances(
  options: WorkflowCommandOptions & {
    workflow: string;
    status?: InstanceStatus;
    limit?: number;
  },
) {
  const manifest = await manifestWithWorkflows(options.cwd);
  const { cf, workflow } = await openWorkflow(options, manifest, options.workflow);
  const instances = await runCfJson(
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
  return { workflow, instances };
}

async function getInstance(
  options: WorkflowCommandOptions & { workflow: string; instanceId: string },
) {
  const manifest = await manifestWithWorkflows(options.cwd);
  const { cf, workflow } = await openWorkflow(options, manifest, options.workflow);
  return { workflow, instance: await readInstance(cf, workflow, options.instanceId) };
}

function readInstance(cf: CfRunner, workflow: AppWorkflow, instanceId: string) {
  return runCfJson(
    cf,
    {
      plane: "account",
      args: ["workflows", "instances", "get", instanceId, "--workflow-name", workflow.name],
    },
    WorkflowInstanceOutput,
  );
}

export async function startInstance(
  options: WorkflowCommandOptions & {
    workflow: string;
    /** A JSON object, checked by the flag's parser. */
    params?: string;
    instanceId?: string;
  },
) {
  const manifest = await manifestWithWorkflows(options.cwd);
  options.out?.emit({
    type: "step",
    step: "workflow.start",
    status: "start",
    message: `Starting ${options.workflow}...`,
  });
  const { cf, workflow } = await openWorkflow(options, manifest, options.workflow);
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
  options.out?.emit({ type: "step", step: "workflow.start", status: "ok" });
  return { workflow, instance: created };
}

/**
 * Pause, resume, terminate or restart an instance. Terminating is for
 * good, so at a terminal it says the instance's status and asks first;
 * unattended it needs `--yes`.
 */
export async function changeInstanceStatus(
  options: WorkflowCommandOptions & {
    workflow: string;
    instanceId: string;
    status: `${StatusChange}`;
    yes?: boolean;
    confirm?: Confirm;
  },
) {
  const change = options.status as StatusChange;
  const manifest = await manifestWithWorkflows(options.cwd);
  const interactive = options.interactive ?? canPromptInTerminal(options.json ?? false);
  const asks = change === StatusChange.Terminate && !options.yes && interactive;
  options.out?.emit({
    type: "step",
    step: "workflow.instance",
    status: "start",
    message: asks ? "Looking up the instance..." : `${CHANGED[change].doing} the instance...`,
  });
  const { cf, workflow } = await openWorkflow(options, manifest, options.workflow);
  if (change === StatusChange.Terminate) {
    // Its status, for the person about to answer.
    const context = asks
      ? [
          `${workflow.binding} instance ${options.instanceId} is ${shownStatus((await readInstance(cf, workflow, options.instanceId)).status)}.`,
        ]
      : undefined;
    await confirmUnlessYes({
      yes: options.yes,
      interactive,
      confirm: options.confirm,
      question: "Terminate it? It stops for good.",
      unattended: "Terminating needs confirmation, and there's no terminal to ask in",
      context,
    });
  }
  const changed = await runCfJson(
    cf,
    {
      plane: "account",
      args: [
        "workflows",
        "instances",
        change,
        options.instanceId,
        "--workflow-name",
        workflow.name,
        "--status",
        change,
        // cf's own question; answered above.
        ...(change === StatusChange.Terminate ? ["--force"] : []),
      ],
    },
    WorkflowStatusOutput,
  );
  options.out?.emit({ type: "step", step: "workflow.instance", status: "ok" });
  return { workflow, status: changed.status ?? null };
}

function commandOptions(flags: GatewayCommandFlags, out: EventSink): WorkflowCommandOptions {
  return {
    cwd: process.cwd(),
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    json: flags.json,
    out,
  };
}

/** A status as --status takes it ("waiting-for-pause"). */
function shownStatus(status: string): string {
  return Object.entries(INSTANCE_STATUSES).find(([, cf]) => cf === status)?.[0] ?? status;
}

/** A status for a person: running cyan, errored red, complete green when `done` says so. */
function coloredStatus(status: string, { complete = false } = {}): string {
  const shown = shownStatus(status);
  if (status === "running") return chalk.cyan(shown);
  if (status === "errored") return chalk.red(shown);
  if (status === "complete" && complete) return chalk.green(shown);
  return shown;
}

/** "2m ago" from an ISO time; null when there's none. */
function ago(time: string | null | undefined, now = Date.now()): string | null {
  if (!time) return null;
  const at = Date.parse(time);
  return Number.isNaN(at) ? null : `${roughly(now - at)} ago`;
}

export async function list(this: LocalContext, flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, async (out) => {
    const { appId, workflows } = await listAppWorkflows(commandOptions(flags, out));
    if (workflows.length === 0) {
      const message = `${appId} declares no Workflows. Add one under resources.workflows in everyapp.config.ts.`;
      out.emit({ type: "done", message, display: chalk.dim(message), data: { workflows } });
      return;
    }
    const counts = (instances: Record<string, number>) => {
      const nonZero = Object.entries(instances).filter(([, count]) => count > 0);
      return nonZero.length > 0
        ? nonZero
            .map(([status, count]) => {
              const text = `${count} ${shownStatus(status)}`;
              return status === "errored" ? chalk.red(text) : text;
            })
            .join(", ")
        : chalk.dim("none");
    };
    const undeployed = workflows.filter((workflow) => !workflow.deployed).map((workflow) => workflow.binding);
    out.emit({
      type: "done",
      display: formatTable(
        ["WORKFLOW", "CLASS", "INSTANCES"],
        workflows.map((workflow) => [
          workflow.binding,
          workflow.className,
          workflow.instances ? counts(workflow.instances) : chalk.yellow("not deployed"),
        ]),
      ).join("\n"),
      data: {
        workflows,
        ...(undeployed.length > 0
          ? { next: [{ command: `${CLI} deploy`, note: `create ${undeployed.join(", ")}` }] }
          : {}),
      },
    });
  });
}

export async function instances(
  this: LocalContext,
  flags: GatewayCommandFlags & { status?: keyof typeof INSTANCE_STATUSES; limit?: number },
  workflow: string,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const listed = await listInstances({
      ...commandOptions(flags, out),
      workflow,
      status: flags.status && INSTANCE_STATUSES[flags.status],
      limit: flags.limit,
    });
    const { binding } = listed.workflow;
    const empty = flags.status
      ? `No ${flags.status} instances of ${binding}.`
      : `${binding} has no instances yet. Start one: ${CLI} workflow start ${binding}`;
    out.emit({
      type: "done",
      display:
        listed.instances.length > 0
          ? formatTable(
              ["ID", "STATUS", "CREATED"],
              listed.instances.map((instance) => [
                instance.id,
                instance.status ? coloredStatus(instance.status) : "",
                ago(instance.created_on) ?? "",
              ]),
            ).join("\n")
          : chalk.dim(empty),
      data: { workflow: listed.workflow.name, instances: listed.instances },
    });
  });
}

export async function get(
  this: LocalContext,
  flags: GatewayCommandFlags,
  workflow: string,
  instanceId: string,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const found = await getInstance({ ...commandOptions(flags, out), workflow, instanceId });
    const { instance } = found;
    const json = (value: unknown) => JSON.stringify(value);
    const started = ago(instance.start);
    const took =
      instance.start && instance.end ? Date.parse(instance.end) - Date.parse(instance.start) : NaN;
    const facts = [
      { label: "Workflow", value: found.workflow.binding },
      { label: "Instance", value: instanceId },
      { label: "Status", value: coloredStatus(instance.status, { complete: true }) },
      ...(started ? [{ label: "Started", value: started }] : []),
      ...(Number.isNaN(took) ? [] : [{ label: "Duration", value: duration(took) }]),
      ...(instance.params !== undefined && instance.params !== null
        ? [{ label: "Params", value: json(instance.params) }]
        : []),
      ...(instance.output !== undefined && instance.output !== null
        ? [{ label: "Output", value: json(instance.output) }]
        : []),
      ...(instance.error
        ? [{ label: "Error", value: chalk.red([instance.error.name, instance.error.message].filter(Boolean).join(": ")) }]
        : []),
    ];
    const steps = (instance.steps ?? []).map((step) => [
      step.name ?? "",
      step.success === true ? chalk.green("✓") : step.success === false ? chalk.red("✗") : chalk.dim("…"),
      step.output === undefined || step.output === null ? "" : json(step.output),
    ]);
    out.emit({
      type: "done",
      display: [
        ...formatFacts(facts),
        ...(steps.length > 0 ? ["", ...formatTable(["STEP", "RESULT", "OUTPUT"], steps)] : []),
      ].join("\n"),
      data: { workflow: found.workflow.name, instance },
    });
  });
}

export async function start(
  this: LocalContext,
  flags: GatewayCommandFlags & { params?: string; "instance-id"?: string },
  workflow: string,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const started = await startInstance({
      ...commandOptions(flags, out),
      workflow,
      params: flags.params,
      instanceId: flags["instance-id"],
    });
    const { binding } = started.workflow;
    const message = `Started instance ${started.instance.id} of ${binding}`;
    out.emit({
      type: "done",
      message,
      display: ticked(message),
      data: {
        workflow: started.workflow.name,
        instance: started.instance,
        next: [
          { command: `${CLI} workflow get ${binding} ${started.instance.id}`, note: "follow its progress" },
        ],
      },
    });
  });
}

async function reportStatusChange(
  flags: GatewayCommandFlags & { yes?: boolean },
  change: { workflow: string; instanceId: string; status: StatusChange },
): Promise<void> {
  await runCommand(flags, async (out) => {
    const changed = await changeInstanceStatus({
      ...commandOptions(flags, out),
      ...change,
      yes: flags.yes,
    });
    const { done, leaves } = CHANGED[change.status];
    const message = `${done} instance ${change.instanceId} of ${changed.workflow.binding}`;
    out.emit({
      type: "done",
      message,
      display: ticked(message, changed.status && changed.status !== leaves ? shownStatus(changed.status) : ""),
      data: {
        workflow: changed.workflow.name,
        instanceId: change.instanceId,
        status: changed.status,
      },
    });
  });
}

function statusCommand(status: Exclude<StatusChange, StatusChange.Terminate>) {
  return async function (
    this: LocalContext,
    flags: GatewayCommandFlags,
    workflow: string,
    instanceId: string,
  ): Promise<void> {
    await reportStatusChange(flags, { workflow, instanceId, status });
  };
}

export const pause = statusCommand(StatusChange.Pause);
export const resume = statusCommand(StatusChange.Resume);
export const restart = statusCommand(StatusChange.Restart);

export async function terminate(
  this: LocalContext,
  flags: GatewayCommandFlags & { yes?: boolean },
  workflow: string,
  instanceId: string,
): Promise<void> {
  await reportStatusChange(flags, { workflow, instanceId, status: StatusChange.Terminate });
}
