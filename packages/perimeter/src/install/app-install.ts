/**
 * Installing an app on a self-hosted Gateway: the one engine `everyapp
 * deploy` / `everyapp install` (the CLI, through `cf`) and the Gateway's
 * browser installs (Admin → Apps → Install app, through Cloudflare's REST
 * API) both run, under the caller's lease on the app:
 *
 *   1. refuse what the deploy would lose (a dropped Durable Object class
 *      or Workflow, without the person's say-so);
 *   2. claim the app's Workers, plan its Email Routing routes (checked
 *      before anything is created) and find or create its resources
 *      (./resources.ts, only ever the app's own);
 *   3. `build` (the CLI, from source), then install the tenant-neutral
 *      Build Output for this deploy (./config.ts), check it against the
 *      policy (./policy.ts), make its R2 buckets and check its Workflows'
 *      names are free or already its own;
 *   4. once nothing else can stop the upload: make sure each Worker may be
 *      replaced (`replaceable`), `migrate` the database, then `upload` the
 *      helper Workers and the app's Worker, each version with GATEWAY_URL,
 *      EVERY_APP_ORG_ID and the defaults of the settings it doesn't hold;
 *   5. delete the Workflows the app dropped, make its mail routes, and read
 *      back its secrets' names for the registry.
 *
 * What differs between the runtimes is a port: how Cloudflare is reached
 * (the resource and email installers, the Workflow and secret reads), where
 * the Build Output lives (the CLI's directory, the Gateway's release in
 * memory), how a Worker changed outside EveryApp is handled (a terminal
 * asks; the browser was asked up front), how the database migrates and how a
 * Worker is uploaded (`cf deploy --prebuilt`, or the REST upload with its
 * Workflows, crons and queue consumers). Registering the app before and
 * recording the deploy after stay with each caller.
 */
import { ManifestSchema, type Manifest } from "@every-app/perimeter/manifest";
import type { AppResources } from "@every-app/perimeter/registry";
import {
  helperWorkerName,
  workflowNameFor,
} from "@every-app/sdk/cloudflare/sentinel";
import {
  isReservedAppSecretName,
  generatedSecret,
  secretEntries,
  settingEntries,
} from "@every-app/sdk/internal";
import { installWorkerConfig, type InstallTarget } from "./config";
import { checkDurableObjects } from "./durable-objects";
import type { createEmailInstaller } from "./email";
import type { Confirm } from "./email-port";
import { InstallationError, type InstallationDatabase } from "./error";
import {
  readOwnedResources,
  RESOURCE_LABELS,
  type OwnedResource,
} from "./ownership";
import {
  boundR2Buckets,
  checkBuildOutput,
  DEFAULT_WORKER,
  definedWorkflows,
  type BuiltWorkerConfig,
} from "./policy";
import type { createResourceProvisioner } from "./resources";
import type { AppSecrets } from "./secrets";

type EventData = Record<string, unknown>;

/** What an install says as it goes: the CLI's events, which the Gateway may drop. */
export type InstallEvent =
  | {
      type: "step";
      step: string;
      status: "start" | "ok" | "skip";
      message?: string;
      data?: EventData;
    }
  | { type: "progress"; step: string; message: string; data?: EventData }
  | {
      type: "warning";
      code: string;
      message: string;
      step?: string;
      data?: EventData;
    };

export interface InstallEvents {
  emit(event: InstallEvent): void;
}

/** One of the app's Workers, installed for this deploy. */
export interface InstalledWorker {
  /** Its Build Output directory: `default` for the app's own Worker. */
  directory: string;
  /** Its name under the manifest's `workers`; "" for the app's own Worker. */
  helper: string;
  workerName: string;
  /** Its installed `worker.config.json`. */
  config: BuiltWorkerConfig;
}

/** An app's Workflow: declared in `resources.workflows`, run by one of its Workers. */
export interface AppWorkflow {
  /** The manifest binding, e.g. RANK_CHECK. */
  binding: string;
  className: string;
  /** The Workflow's name in the account. */
  name: string;
  /** The Worker that runs it: the app's own, or one of its helper Workers. */
  worker: string;
}

/** How one runtime reaches Cloudflare and keeps the Build Output. */
export interface AppInstallPorts<C> {
  /** The account client: `cf` in the CLI, a REST transport in the Gateway. */
  cf: C;
  /** The Gateway's D1: the resource ledger and the app's email. */
  db: InstallationDatabase;
  out: InstallEvents;
  /** How a person runs the CLI (`everyapp`), for the commands messages name. */
  CLI: string;
  /** The command that runs this install again ("" outside the CLI). */
  thisCommand(): string;
  resources: ReturnType<typeof createResourceProvisioner<C>>;
  email: ReturnType<typeof createEmailInstaller<C>>;
  /** The Workflow with this name, or null when the account has none. */
  getWorkflow(
    cf: C,
    name: string,
  ): Promise<{ script_name?: string | null } | null>;
  /** Delete a Workflow with its instances; one already gone is no error. */
  deleteWorkflow(cf: C, name: string): Promise<void>;
  /** The Worker's secrets' names; none when there is no such Worker yet. */
  workerSecretNames(cf: C, workerName: string): Promise<string[]>;
  /** Builds the app from source, once its resources exist (the CLI's `deploy`). */
  build?(target: InstallTarget): Promise<void>;
  /** The tenant-neutral Build Output's Workers, by directory. */
  readBuildOutput(): Promise<Map<string, BuiltWorkerConfig>>;
  /** Keep the installed Workers for the upload (the CLI writes them back to disk). */
  writeBuildOutput(workers: readonly InstalledWorker[]): Promise<void>;
  /** Once the Build Output is installed and checked: the Workflows its Workers define. */
  built?(workflows: string[]): Promise<void>;
  /**
   * Refuse to replace a Worker whose serving version EveryApp didn't
   * upload, unless the person agrees (the CLI asks at a terminal; the
   * browser asked before the install started).
   */
  replaceable(worker: {
    workerName: string;
    shownAs: string;
    recordedVersionIds: ReadonlyArray<string | null | undefined>;
  }): Promise<void>;
  /** Migrate the app's database; nothing has been uploaded yet. */
  migrate(resources: InstallTarget["resources"]): Promise<void>;
  /**
   * Upload one Worker's installed Build Output with `values` as its
   * version's secrets, and record the version (`recordUploadedVersion`) as
   * soon as it is known. The version now serving.
   */
  upload(
    worker: InstalledWorker,
    values: Readonly<Record<string, string>>,
    target: InstallTarget,
  ): Promise<string | null>;
  /** Before each step that changes the account or the data: the lease still holds. */
  checkpoint(): Promise<void>;
}

export interface AppInstallInput {
  manifest: Manifest;
  /** The manifest of the code deployed before, to compare against. */
  previousManifest: Manifest | null;
  workerName: string;
  /** The names the registration gave the app's resources. */
  resources: AppResources;
  /** The version the registry recorded for the app's Worker. */
  recordedVersionId: string | null;
  organizationId: string;
  accountId: string;
  gatewayUrl: string;
  /** The Gateway's own Worker, which the app's GATEWAY binding names. */
  gatewayWorker: string;
  identityPublicKeys: string[];
  /** Hyperdrive origins and Secrets Store values (the app's secrets file, or the install form). */
  secrets?: AppSecrets;
  /** More values for every Worker's version: the app's secrets and settings the install form set. */
  values?: Readonly<Record<string, string>>;
  /**
   * The installation's email lists, as the registry row holds them: read
   * under the lease, so `everyapp email set` can't change them between the
   * check and the routes made after the upload.
   */
  readEmail(): Promise<{
    inbound: readonly string[];
    senders: readonly string[];
  }>;
  /** Whether `everyapp email set --sender` takes this app's senders. */
  sendersSettable: boolean;
  /** A person can answer questions (Email Routing, a Worker changed outside EveryApp). */
  interactive: boolean;
  confirm?: Confirm;
  enableEmailRouting?: boolean;
  /** Turn Email Routing on even over MX records that deliver a domain's mail elsewhere (`--replace-mx`). */
  replaceMx?: boolean;
  allowDeleteDurableObjectData?: boolean;
  allowDeleteWorkflows?: boolean;
}

export interface AppInstallResult {
  /** The version of the app's Worker now serving. */
  versionId: string;
  target: InstallTarget;
  /** The app's own secrets' names, or null when they couldn't be listed. */
  secretNames: string[] | null;
  /** What to run next. */
  next: Array<{ command: string; note: string }>;
}

/** The Workflows a manifest declares, named after `workerName`. */
export function appWorkflows(
  workerName: string,
  manifest: Pick<Manifest, "resources">,
): AppWorkflow[] {
  return (manifest.resources?.workflows ?? []).map((workflow) => ({
    binding: workflow.name,
    className: workflow.className,
    name: workflowNameFor(workerName, workflow.name),
    worker: workflow.worker
      ? helperWorkerName(workerName, workflow.worker)
      : workerName,
  }));
}

export async function installApp<C>(
  input: AppInstallInput,
  ports: AppInstallPorts<C>,
): Promise<AppInstallResult> {
  const { manifest, workerName, accountId } = input;
  const { cf, db, out, CLI } = ports;
  const deletedDurableObjects = checkDurableObjects(
    { previousManifest: input.previousManifest },
    manifest,
    input.allowDeleteDurableObjectData ?? false,
  );
  const deletedWorkflows = await droppedWorkflows(input, ports);

  // Only what this app created (and recorded as its own) is used; a name
  // that's taken by anything else is refused, on every attempt.
  let createdHyperdrive = false;
  const ownership = {
    cf,
    gatewayDb: db,
    registration: { workerName, resources: input.resources },
    onCreated: (description: string, kind: OwnedResource["kind"]) => {
      out.emit({
        type: "progress",
        step: "app.resources",
        message: `Created ${description}.`,
      });
      if (kind === "hyperdrive") createdHyperdrive = true;
    },
    onRecreated: (description: string, kind: OwnedResource["kind"]) =>
      out.emit({
        type: "warning",
        code: "RESOURCE_RECREATED",
        step: "app.resources",
        message: `The ${kind === "d1" ? "database" : RESOURCE_LABELS[kind]} ${manifest.id} used before is gone; creating a new, empty one\n${description} no longer exists in this Cloudflare account.`,
      }),
    onChanged: (message: string) =>
      out.emit({ type: "progress", step: "app.resources", message }),
  };
  // The app's helper Workers (`workers`), named after its own.
  const helpers = (manifest.workers ?? []).map((helper) => ({
    name: helper.name,
    workerName: helperWorkerName(workerName, helper.name),
  }));
  out.emit({
    type: "step",
    step: "app.resources",
    status: "start",
    message: "Preparing the app's resources...",
  });
  await ports.resources.claimAppWorker(ownership);
  for (const helper of helpers)
    await ports.resources.claimAppWorker(ownership, helper);
  // Without the manifest's declaration no Worker of the app receives mail:
  // its routes go, its addresses stay stored.
  const storedEmail = await input.readEmail();
  const declaresInbound = ports.email.emailDeclarations(manifest).receives;
  if (!declaresInbound && storedEmail.inbound.length > 0) {
    out.emit({
      type: "warning",
      code: "EMAIL_INBOUND_UNDECLARED",
      step: "app.email",
      message: `everyapp.config.ts no longer declares inbound email; removing the app's mail routes\nIts addresses (${storedEmail.inbound.join(", ")}) stay on the Gateway until you clear them.`,
      data: { rerun: `${CLI} email unset inbound` },
    });
  }
  // Mail routes are checked before anything is created: an address another
  // app or rule has, or a domain whose routing stays off, stops the deploy.
  const emailRoutes = await ports.email.planEmailRoutes({
    cf,
    gatewayDb: db,
    accountId,
    workerName,
    addresses: declaresInbound ? storedEmail.inbound : [],
    interactive: input.interactive,
    enableRouting: input.enableEmailRouting,
    replaceMx: input.replaceMx,
    confirm: input.confirm,
  });
  const resources = await ports.resources.provisionAppResources({
    ...ownership,
    manifest,
    secrets: input.secrets,
    accountId,
  });
  out.emit({
    type: "step",
    step: "app.resources",
    status: "ok",
    message: "The app's resources are ready.",
  });
  if (createdHyperdrive) {
    const caching = manifest.resources?.hyperdrive?.some(
      (config) => config.caching === "default",
    )
      ? "default"
      : "off";
    out.emit({
      type: "step",
      step: "app.hyperdrive",
      status: "ok",
      message: "Created the app's Hyperdrive config.",
      data: { caching },
    });
  }

  const target: InstallTarget = {
    workerName,
    organizationId: input.organizationId,
    accountId,
    gatewayUrl: input.gatewayUrl,
    gatewayWorker: input.gatewayWorker,
    identityPublicKeys: input.identityPublicKeys,
    resources,
    deletedDurableObjects,
    helperWorkers: helpers.map((helper) => helper.workerName),
    declared: manifest.resources,
  };
  await ports.build?.(target);
  const workers = await installBuildOutput(target, helpers, ports);
  const workflows = workers.flatMap((worker) =>
    definedWorkflows(worker.config, worker.workerName),
  );
  const createdBuckets = await ports.resources.ensureAppBuckets({
    ...ownership,
    onCreated: undefined,
    onRecreated: undefined,
    names: [
      ...new Set(workers.flatMap((worker) => boundR2Buckets(worker.config))),
    ].sort(),
    appId: manifest.id,
  });
  for (const name of createdBuckets)
    out.emit({
      type: "progress",
      step: "app.build",
      message: `Created R2 bucket "${name}".`,
      data: { bucket: name },
    });
  // Workflow names are account-wide, and a deploy's update reassigns a name
  // another Worker holds: each must be free or already that Worker's.
  for (const worker of workers) {
    for (const name of definedWorkflows(worker.config, worker.workerName)) {
      const existing = await ports.getWorkflow(cf, name);
      if (existing && existing.script_name !== worker.workerName) {
        throw new InstallationError(
          "WORKFLOW_NAME_TAKEN",
          `A Workflow named "${name}" already exists in this Cloudflare account\nIt runs on Worker ${existing.script_name ?? "(unknown)"}, not ${worker.workerName}; deploying would take it over.`,
          {
            fix: "delete or rename it",
            rerun: ports.thisCommand() || undefined,
          },
        );
      }
    }
  }
  await ports.built?.(workflows);

  // The database changes only once nothing else can stop the upload.
  const workerRecords = (await readOwnedResources(db, workerName)).filter(
    (resource) => resource.kind === "worker",
  );
  const recordedVersion = (binding: string) =>
    workerRecords.find((record) => record.binding === binding)?.versionId;
  for (const worker of [
    {
      workerName,
      shownAs: manifest.id,
      recordedVersionIds: [input.recordedVersionId, recordedVersion("")],
    },
    ...helpers.map((helper) => ({
      workerName: helper.workerName,
      shownAs: `${manifest.id}'s ${helper.name} Worker`,
      recordedVersionIds: [recordedVersion(helper.name)],
    })),
  ])
    await ports.replaceable(worker);
  await ports.checkpoint();
  await ports.migrate(resources);

  // What every Worker of the app gets with its version: what names the
  // gateway and the organization to the SDK. A helper calls the gateway
  // too (a crawl's rendering, say), and without EVERY_APP_ORG_ID it would
  // name the app's own organization id, which the gateway refuses. With
  // them, the default of each plain setting (`settings`) the Worker doesn't
  // hold yet (an app reads one nobody has set as its default), and each
  // top-level secret it generates, so the app opens after its first deploy.
  const values = {
    ...(await initialValuesToWrite(input, ports)),
    ...input.values,
    GATEWAY_URL: input.gatewayUrl,
    EVERY_APP_ORG_ID: input.organizationId,
  };

  // Helper Workers first: the app's Worker binds them, so each must be
  // there (with any new class) before the version that uses it.
  for (const worker of workers.filter((worker) => worker.helper !== "")) {
    await ports.checkpoint();
    const data = { name: worker.helper, workerName: worker.workerName };
    out.emit({
      type: "step",
      step: "app.helper",
      status: "start",
      message: `Uploading ${worker.workerName}...`,
      data,
    });
    await ports.upload(worker, values, target);
    out.emit({
      type: "step",
      step: "app.helper",
      status: "ok",
      message: `Uploaded ${worker.workerName}.`,
      data,
    });
  }
  await ports.checkpoint();
  out.emit({
    type: "step",
    step: "app.upload",
    status: "start",
    message: `Uploading ${workerName}...`,
  });
  const versionId = await ports.upload(
    workers.find((worker) => worker.helper === "")!,
    values,
    target,
  );
  if (!versionId) {
    throw new InstallationError(
      "VERSION_UNKNOWN",
      `Cloudflare reports no version for ${manifest.id} after the upload`,
      { data: { workerName } },
    );
  }
  out.emit({
    type: "step",
    step: "app.upload",
    status: "ok",
    message: `Uploaded version ${versionId}.`,
    data: { versionId },
  });
  // The live version no longer defines them. Before the registry records
  // the new manifest, so a retry after a failed delete deletes them still.
  for (const workflow of deletedWorkflows) {
    await ports.deleteWorkflow(cf, workflow.name);
    out.emit({
      type: "step",
      step: "app.workflows",
      status: "ok",
      message: `Deleted the Workflow ${workflow.binding} (${workflow.name}) with its instances.`,
      data: { binding: workflow.binding, name: workflow.name },
    });
  }

  const next: AppInstallResult["next"] = [];
  const { senders } = storedEmail;
  const { sendersSettable } = input;
  // The rules name the Worker, so they come once it is there.
  if (emailRoutes) {
    await ports.checkpoint();
    out.emit({
      type: "step",
      step: "app.email",
      status: "start",
      message: `Routing ${manifest.id}'s mail...`,
      data: { removing: emailRoutes.routes.length === 0 },
    });
    const { routed, removed } = await ports.email.applyEmailRoutes({
      cf,
      gatewayDb: db,
      plan: emailRoutes,
      onProgress: (message) =>
        out.emit({ type: "progress", step: "app.email", message }),
    });
    const unsent = sendersSettable
      ? ports.email.unsentDomains(routed, senders)
      : [];
    out.emit({
      type: "step",
      step: "app.email",
      status: "ok",
      message: ports.email.describeMailRoutes({
        appId: manifest.id,
        workerName,
        senders,
        routed,
        removed,
        sendersSettable,
      }),
      data: {
        addresses: routed,
        removed,
        enabled: emailRoutes.enable.map(({ domain }) => domain),
        ...(unsent.length > 0
          ? {
              replyHint: `To reply from ${unsent.join(", ")}, set up Email Sending, then: ${CLI} email set --sender`,
            }
          : {}),
      },
    });
  }
  if (!emailRoutes && declaresInbound && storedEmail.inbound.length === 0) {
    out.emit({
      type: "step",
      step: "app.email",
      status: "skip",
      message: `${manifest.id} receives no mail yet.`,
    });
    next.push({
      command: `${CLI} email set --inbound <address>`,
      note: `optional: routes mail on your domain to ${manifest.id}`,
    });
  }
  // Until a sender is set, the app sends as the Gateway's sender.
  if (sendersSettable && senders.length === 0) {
    next.push({
      command: `${CLI} email set --sender '*@<domain>'`,
      note: `optional: lets ${manifest.id} send as your domain`,
    });
  }
  // A helper Worker the manifest dropped keeps running (with its crons)
  // until the app is purged: the deploy never deletes a Worker.
  const droppedHelpers = (input.previousManifest?.workers ?? [])
    .map((helper) => String(helper.name))
    .filter((name) => !helpers.some((helper) => helper.name === name));
  for (const name of droppedHelpers) {
    out.emit({
      type: "warning",
      code: "HELPER_WORKER_KEPT",
      step: "app.upload",
      message: `Helper Worker ${name} is no longer in everyapp.config.ts, but it still runs\nIts Worker is ${helperWorkerName(workerName, name)}.`,
      data: { fix: "delete that Worker in the Cloudflare dashboard" },
    });
  }
  // The Worker's own secret names, recorded with the version so the
  // gateway knows what is set. The upload stands when they can't be listed.
  const secretNames = await ports
    .workerSecretNames(cf, workerName)
    .then((names) => names.filter((name) => !isReservedAppSecretName(name)))
    .catch((error: unknown) => {
      out.emit({
        type: "progress",
        step: "app.secrets",
        message: `Couldn't list ${workerName}'s secrets: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
      });
      return null;
    });
  return { versionId, target, secretNames, next };
}

/**
 * Workflows the last deploy had that this one drops, among those that still
 * run on the Worker that defined them (the app's or a helper's): like a
 * Durable Object class, deleting one deletes its instances, so only with
 * the person's say-so (`--allow-delete-workflows`).
 */
async function droppedWorkflows<C>(
  input: AppInstallInput,
  ports: AppInstallPorts<C>,
): Promise<AppWorkflow[]> {
  const previous = ManifestSchema.safeParse(input.previousManifest);
  if (!previous.success) return [];
  const kept = appWorkflows(input.workerName, input.manifest).map(
    (workflow) => workflow.name,
  );
  const removed: AppWorkflow[] = [];
  for (const workflow of appWorkflows(input.workerName, previous.data)) {
    if (kept.includes(workflow.name)) continue;
    // A first deploy that was refused registered a name another Worker runs.
    if (
      (await ports.getWorkflow(ports.cf, workflow.name))?.script_name ===
      workflow.worker
    )
      removed.push(workflow);
  }
  if (removed.length > 0 && !input.allowDeleteWorkflows) {
    const one = removed.length === 1;
    throw new InstallationError(
      "WORKFLOW_REMOVED",
      `Deploying would delete the Workflow${one ? "" : "s"} ${removed.map((workflow) => workflow.binding).join(", ")} and ${one ? "its" : "their"} instances\neveryapp.config.ts no longer declares ${one ? "it" : "them"}. Renaming a binding renames its Workflow.`,
    );
  }
  return removed;
}

/**
 * Every Worker of a tenant-neutral Build Output installed for `target`, by
 * directory, once the policy found nothing to refuse (APP_POLICY).
 */
export function installBuiltWorkers(
  built: ReadonlyMap<string, BuiltWorkerConfig>,
  target: InstallTarget,
): Map<string, BuiltWorkerConfig> {
  const installed = new Map<string, BuiltWorkerConfig>();
  for (const [directory, config] of built)
    installed.set(directory, installWorkerConfig(config, target));
  checkBuildOutput(installed, target);
  return installed;
}

/** Install every Worker of the Build Output for `target`, check them, and keep them for the upload. */
async function installBuildOutput<C>(
  target: InstallTarget,
  helpers: ReadonlyArray<{ name: string; workerName: string }>,
  ports: AppInstallPorts<C>,
): Promise<InstalledWorker[]> {
  const installed = installBuiltWorkers(await ports.readBuildOutput(), target);
  // The app's Worker, then its helpers in the manifest's order (the policy
  // found each declared one, and no other).
  const built = [...installed];
  const workers: InstalledWorker[] = [
    {
      directory: DEFAULT_WORKER,
      helper: "",
      workerName: target.workerName,
      config: installed.get(DEFAULT_WORKER)!,
    },
    ...helpers.map((helper) => {
      const [directory, config] = built.find(
        ([directory, config]) =>
          directory !== DEFAULT_WORKER && config.name === helper.workerName,
      )!;
      return {
        directory,
        helper: helper.name,
        workerName: helper.workerName,
        config,
      };
    }),
  ];
  await ports.writeBuildOutput(workers);
  return workers;
}

/**
 * What the app's Worker doesn't hold yet, to send with the version the
 * deploy uploads: the defaults of the manifest's plain settings (one
 * nobody has set reads its default, as in development), and a fresh value
 * for each top-level secret it generates (`generate: true`) that has no
 * `how` (one a person pastes somewhere is made by `everyapp configure`,
 * which shows it). What the Worker holds, the default or a value someone
 * set, is never replaced. Without either, Cloudflare isn't asked.
 */
async function initialValuesToWrite<C>(
  input: AppInstallInput,
  ports: AppInstallPorts<C>,
): Promise<Record<string, string>> {
  const defaults = settingEntries(input.manifest).filter(
    (entry) => entry.default !== undefined,
  );
  const generated = secretEntries(input.manifest).filter(
    (entry) => entry.generate && entry.feature === undefined && !entry.how,
  );
  if (defaults.length === 0 && generated.length === 0) return {};
  const held = await ports.workerSecretNames(ports.cf, input.workerName);
  return Object.fromEntries([
    ...defaults
      .filter((entry) => !held.includes(entry.name))
      .map((entry) => [entry.name, entry.default!]),
    ...generated
      .filter((entry) => !held.includes(entry.name))
      .map((entry) => [entry.name, generatedSecret()]),
  ]);
}
