/**
 * `everyapp secret set|unset|list`: the app's secrets and the Gateway's
 * settings, each by name, with no flag to say which.
 *
 * A name that is one of the Gateway's settings (`SETTABLE_GATEWAY_SETTINGS`
 * in `@every-app/sdk/internal`: OPENAI_API_KEY, EMAIL_FROM, the OAuth
 * clients, …) goes to the Gateway Worker, from any directory, and the
 * app's manifest is never read for it. Any other name goes to the app
 * whose everyapp.config.ts is in the current directory, when that manifest
 * lists it under `secrets` (`unset` takes any name the app could have, so
 * a secret dropped from the manifest can still be removed, and says so).
 * Anything else is refused before a value is read. One call may mix the
 * two; each name goes where it belongs, the Gateway's first.
 *
 * A value comes from a hidden prompt or `--from-env VAR`, never the
 * command line. `set` and `unset` change the live Worker and never deploy:
 * every target is checked first (the app is registered, each Worker
 * serves a version everyapp recorded), then one `cf workers secrets bulk`
 * call per Worker (the app's and each of its helpers', or the Gateway's)
 * makes a new version with the change, under the Worker's lease, and that
 * version is recorded as everyapp's own (the app's Worker record, or the
 * install row's `live_version_id`), so the next `deploy` or `setup`
 * replaces it unattended. The secret is live at once. `list` prints names,
 * never values: the app's Workers' (with the names its manifest lists but
 * nobody set yet) and the Gateway settings its providers and capabilities
 * need, or outside an app directory, the Gateway's.
 */
import { stripVTControlCharacters } from "node:util";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { isReservedAppSecretName } from "@every-app/sdk/internal";
import chalk from "chalk";
import {
  gatewaySettingsFor,
  isDevOnlyGatewaySetting,
  isInstallOwnedGatewaySetting,
  isSettableGatewaySetting,
  SETTABLE_GATEWAY_SETTINGS,
} from "@every-app/sdk/internal";
import type { LocalContext } from "@/context";
import { readOwnedResources, recordUploadedVersion } from "@/lib/app/ownership";
import { assertAppSecretName } from "@/lib/app/secrets";
import { deviceLoginAction } from "@/lib/cf/account";
import type { D1Database } from "@/lib/cf/d1";
import { assertReplaceable, canPromptInTerminal } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets, patchWorkerSecrets } from "@/lib/cf/secrets";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { EveryAppError } from "@/lib/errors";
import { acquireGatewayLease } from "@/lib/gateway/apply";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { readInstall, writeInstall } from "@/lib/gateway/install";
import { acquireLease, describeLeaseHolder } from "@/lib/gateway/lease";
import { readApp } from "@/lib/gateway/registry";
import {
  loadEveryAppManifestIfPresent,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import { readSecretValue } from "@/lib/secretValue";

interface SecretFlags {
  gateway?: string;
  "account-id"?: string;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** What the handlers take from the command line, and the seams tests use. */
export interface SecretOptions {
  flags: SecretFlags;
  out: EventSink;
  /** The directory whose everyapp.config.ts names the app (default: the working directory). */
  cwd?: string;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
}

export async function set(
  this: LocalContext,
  flags: SecretFlags & { "from-env"?: string },
  ...names: string[]
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    () =>
      setSecrets({
        flags,
        out,
        names,
        readValue: (name) =>
          readSecretValue(name, { fromEnv: flags["from-env"], json: flags.json }),
        fromEnv: flags["from-env"],
      }),
    { verbose: flags.verbose },
  );
}

export async function unset(
  this: LocalContext,
  flags: SecretFlags,
  ...names: string[]
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(out, () => unsetSecrets({ flags, out, names }), {
    verbose: flags.verbose,
  });
}

export async function list(
  this: LocalContext,
  flags: Omit<SecretFlags, "yes">,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(out, () => listSecrets({ flags, out }), {
    verbose: flags.verbose,
  });
}

/** `secret set`: every name routed, then each value read, then the changes applied. */
export async function setSecrets(
  options: SecretOptions & {
    names: string[];
    /** A name's value: the hidden prompt, or `--from-env`. */
    readValue: (name: string) => Promise<string>;
    fromEnv?: string;
  },
): Promise<void> {
  const { names, out } = options;
  if (options.fromEnv && names.length > 1) {
    throw new EveryAppError(
      "SECRET_VALUE_REQUIRED",
      "--from-env reads one value: set one secret at a time with it.",
    );
  }
  const route = await routeNames(names, options.cwd ?? process.cwd(), "set");
  const changes: Record<string, string> = {};
  for (const name of names) changes[name] = await options.readValue(name);
  const applied = await apply(route, changes, options);
  out.emit({
    type: "done",
    message: `Set ${describe(applied)}.`,
    data: doneData(applied),
  });
}

/** `secret unset`: every name routed, then removed from the Workers that hold it. */
export async function unsetSecrets(
  options: SecretOptions & { names: string[] },
): Promise<void> {
  const { names, out } = options;
  const route = await routeNames(names, options.cwd ?? process.cwd(), "unset");
  const changes = Object.fromEntries(names.map((name) => [name, null]));
  const applied = await apply(route, changes, options);
  out.emit({
    type: "done",
    message: `Removed ${describe(applied, "from")}.`,
    data: doneData(applied),
  });
}

/** `secret list`: the app's Workers' names and the Gateway settings it needs, or the Gateway's names. */
export async function listSecrets(options: SecretOptions): Promise<void> {
  const { out } = options;
  const manifest = await loadEveryAppManifestIfPresent(options.cwd ?? process.cwd());
  const { cf, db } = await connect(options);
  const gatewayNames = await listWorkerSecrets(cf, GATEWAY_WORKER_NAME);
  const settable = [...SETTABLE_GATEWAY_SETTINGS];
  if (!manifest) {
    const display =
      gatewayNames.length > 0
        ? formatTable(["NAME", "WHERE"], gatewayNames.map((name) => [name, "Gateway"])).join("\n")
        : chalk.dim("The Gateway has no secrets.");
    out.emit({
      type: "done",
      message: stripVTControlCharacters(display),
      display,
      data: { gateway: { workerName: GATEWAY_WORKER_NAME, names: gatewayNames, settable } },
    });
    return;
  }

  const declared = [...(manifest.secrets ?? [])];
  const needs = gatewaySettingsFor(manifest).map((need) => ({
    ...need,
    set: gatewayNames.includes(need.name),
  }));
  const gatewayMissing = needs
    .filter((need) => need.required && !need.set)
    .map((need) => need.name);

  // The app's Workers, once it is deployed: its own, then each helper.
  let workerName: string | null = null;
  try {
    workerName = (await readApp(db, manifest.id)).workerName;
  } catch (error) {
    if (!(error instanceof EveryAppError && error.code === "APP_NOT_FOUND")) throw error;
  }
  const workers: Array<{ workerName: string; names: string[]; missing: string[] }> = [];
  if (workerName) {
    const helpers = (await readOwnedResources(db, workerName))
      .filter((resource) => resource.kind === "worker" && resource.binding !== "")
      .map((resource) => resource.name);
    for (const name of [workerName, ...helpers]) {
      const names = await listWorkerSecrets(cf, name);
      workers.push({
        workerName: name,
        names,
        missing: declared.filter((secret) => !names.includes(secret)),
      });
    }
  }

  // One row per name: the app's own (everyapp's, with --verbose), then the
  // Gateway settings it uses.
  const notSet = chalk.yellow("not set");
  const rows: string[][] = [];
  workers.forEach((worker, index) => {
    // A helper Worker is named `<app's Worker>--<helper>`.
    const where = index === 0 ? manifest.id : `${worker.workerName.split("--").at(-1)} helper`;
    for (const name of worker.names) {
      if (options.flags.verbose || !isReservedAppSecretName(name)) rows.push([name, where, "set"]);
    }
    for (const name of worker.missing) rows.push([name, where, notSet]);
  });
  if (!workerName) {
    for (const name of declared) rows.push([name, manifest.id, chalk.dim("app not deployed yet")]);
  }
  for (const need of needs) {
    rows.push([
      need.name,
      "Gateway",
      need.set ? "set" : need.required ? notSet : chalk.dim("not set (optional)"),
    ]);
  }
  const display =
    rows.length > 0
      ? formatTable(["NAME", "WHERE", "STATUS"], rows).join("\n")
      : chalk.dim(`${manifest.id} has no secrets.`);
  const toSet = [...new Set([...(workers[0]?.missing ?? []), ...gatewayMissing])];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(display),
    display,
    data: {
      app: { id: manifest.id, deployed: workerName !== null, workerName, declared, workers },
      gateway: {
        workerName: GATEWAY_WORKER_NAME,
        names: gatewayNames,
        needed: needs,
        missing: gatewayMissing,
        settable,
      },
      ...(toSet.length > 0 ? { next: [`pnpm everyapp secret set ${toSet.join(" ")}`] } : {}),
    },
  });
}

/** Where a call's names go, decided from the name list and the manifest alone. */
interface Route {
  gateway: string[];
  app: { manifest: EveryAppCliManifest; names: string[] } | null;
  /** Said before anything changes: an `unset` of a name the manifest doesn't list. */
  warnings: string[];
}

/** What one call changed, for its message and `done` data. */
interface Applied {
  gateway?: { names: string[]; versions: Record<string, string | null> };
  app?: {
    id: string;
    workerName: string;
    names: string[];
    versions: Record<string, string | null>;
  };
}

/**
 * Route every name without the network: a Gateway setting goes to the
 * Gateway; anything else needs the manifest in `cwd` (read only then, so a
 * Gateway-only call never evaluates it), which must list the name for
 * `set`. A name that goes nowhere is refused here, before a value is read.
 */
async function routeNames(
  names: string[],
  cwd: string,
  action: "set" | "unset",
): Promise<Route> {
  if (names.length === 0) {
    throw new EveryAppError("SECRET_NAME_REQUIRED", "Name the secret to change.");
  }
  const gateway = names.filter((name) => isSettableGatewaySetting(name));
  const rest = names.filter((name) => !isSettableGatewaySetting(name));
  if (rest.length === 0) return { gateway, app: null, warnings: [] };

  const manifest = await loadEveryAppManifestIfPresent(cwd);
  const declared = manifest?.secrets ?? [];
  const warnings: string[] = [];
  for (const name of rest) {
    assertAppSecretName(name);
    if (!manifest) throw notRoutable(name, null);
    if (declared.includes(name)) continue;
    if (action === "set") throw notRoutable(name, manifest);
    warnings.push(
      `${name} isn't listed under secrets in everyapp.config.ts; removing it from ${manifest.id}'s Workers anyway.${didYouMean(name, declared)}`,
    );
  }
  return { gateway, app: { manifest: manifest!, names: rest }, warnings };
}

/** Why a name goes nowhere, and what to do instead. */
function notRoutable(name: string, manifest: EveryAppCliManifest | null): EveryAppError {
  const own = isInstallOwnedGatewaySetting(name)
    ? name === "THIRD_PARTY_DEPLOYS"
      ? `${name} is the hosted Gateway's launch gate, opened by hand (docs/runbooks/hosted-install.md); this command never changes it.`
      : `${name} is one of the Gateway's own settings, written once by \`everyapp setup\`; this command never changes it.`
    : isDevOnlyGatewaySetting(name)
      ? `${name} is for local testing only, in the gateway's .dev.vars; a deployed Gateway doesn't read it.`
      : null;
  if (!manifest) {
    if (own) return new EveryAppError("SECRET_NOT_SETTABLE", own);
    return new EveryAppError(
      "SECRET_NOT_DECLARED",
      `${name} isn't a Gateway setting.${didYouMean(name, SETTABLE_GATEWAY_SETTINGS)} To set an app's own secret, run this in the app's directory, where everyapp.config.ts lists it under secrets. \`everyapp secret list --json\` includes every Gateway setting this command sets (gateway.settable).`,
    );
  }
  const uses = gatewaySettingsFor(manifest).map((need) => need.name);
  return new EveryAppError(
    "SECRET_NOT_DECLARED",
    [
      `${name} isn't a Gateway setting, and ${manifest.id} doesn't list it under secrets in everyapp.config.ts; add it there to set it on the app.`,
      didYouMean(name, [...SETTABLE_GATEWAY_SETTINGS, ...(manifest.secrets ?? [])]).trim(),
      own
        ? `It is also one of the Gateway's own settings, which \`everyapp setup\` writes; listing it under secrets gives ${manifest.id} a secret of its own.`
        : "",
      uses.length > 0 ? `Gateway settings ${manifest.id} uses: ${uses.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/** " Did you mean X?" for a name that differs from a known one in case or underscores only. */
function didYouMean(name: string, known: readonly string[]): string {
  const fold = (value: string) => value.toUpperCase().replace(/_/g, "");
  const match = known.find((candidate) => candidate !== name && fold(candidate) === fold(name));
  return match ? ` Did you mean ${match}?` : "";
}

async function connect(options: SecretOptions) {
  const { flags, out } = options;
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    onDeviceLogin: flags.json ? deviceLoginAction(out, "login") : undefined,
    ...(options.createCf ? { createCf: options.createCf } : {}),
  });
}

/** A Worker whose secrets change: what changes there, and how its new version is recorded. */
interface Target {
  workerName: string;
  changes: Record<string, string | null>;
  recordedVersionIds: ReadonlyArray<string | null | undefined>;
  record: (versionId: string) => Promise<void>;
}

/**
 * Apply the changes where each name goes, every check before the first
 * change: connect, find the app's Workers, take the Gateway's lease and
 * then the app's, run the replace check on every target (and for `unset`,
 * see which targets hold the names), then patch each in turn, the
 * Gateway's first. A failure after a patch landed says what already
 * changed, so the person doesn't enter that value again.
 */
async function apply(
  route: Route,
  changes: Readonly<Record<string, string | null>>,
  options: SecretOptions,
): Promise<Applied> {
  const { out } = options;
  const interactive = canPromptInTerminal(options.flags.json ?? false);
  const removing = Object.values(changes).every((value) => value === null);
  const pick = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, changes[name] ?? null]));

  const { cf, db, deployer } = await connect(options);
  const app = route.app
    ? { ...route.app, workerName: (await readApp(db, route.app.manifest.id)).workerName }
    : null;
  for (const name of route.gateway) {
    out.emit({ type: "progress", step: "secrets.route", message: `${name}: ${GATEWAY_WORKER_NAME}` });
  }
  for (const name of app?.names ?? []) {
    out.emit({ type: "progress", step: "secrets.route", message: `${name}: ${app!.workerName}` });
  }
  for (const message of route.warnings) {
    out.emit({ type: "warning", code: "SECRET_NOT_DECLARED", message });
  }

  const gatewayLease =
    route.gateway.length > 0 ? await acquireGatewayLease({ db, out }, "gateway.secrets") : null;
  try {
    const appLease = app
      ? await acquireLease({
          db,
          id: `app:${app.workerName}`,
          purpose: "app.secrets",
          onWait: (holder) =>
            out.emit({
              type: "progress",
              step: "app.lease",
              message: `Waiting for another deploy of ${app.manifest.id} to finish (${describeLeaseHolder(holder)})...`,
            }),
          onHeartbeatProblem: (message) =>
            out.emit({ type: "warning", code: "LEASE_HEARTBEAT", step: "app.lease", message }),
        })
      : null;
    try {
      const targets: Target[] = [];
      if (gatewayLease) {
        // Under the lease, the install row is the last deploy's for sure.
        const install = await readInstall(db);
        if (!install) {
          throw new EveryAppError(
            "GATEWAY_NOT_INSTALLED",
            "No Gateway install record: run `everyapp setup` first.",
          );
        }
        targets.push({
          workerName: GATEWAY_WORKER_NAME,
          changes: pick(route.gateway),
          recordedVersionIds: [install.liveVersionId],
          record: (versionId) =>
            writeInstall(db, {
              ...install,
              liveVersionId: versionId,
              updatedAt: Date.now(),
              updatedBy: deployer.actor,
            }),
        });
      }
      if (app) {
        const records = (await readOwnedResources(db, app.workerName)).filter(
          (resource) => resource.kind === "worker",
        );
        const recorded = records.map((record) => record.versionId);
        // The app's own Worker first, then each helper deployed with it.
        targets.push({
          workerName: app.workerName,
          changes: pick(app.names),
          recordedVersionIds: recorded,
          record: (versionId) => recordUploadedVersion(db, app.workerName, versionId),
        });
        for (const record of records.filter((record) => record.binding !== "")) {
          targets.push({
            workerName: record.name,
            changes: pick(app.names),
            recordedVersionIds: recorded,
            record: (versionId) =>
              recordUploadedVersion(db, app.workerName, versionId, record.binding),
          });
        }
      }

      // Every check, then every change.
      for (const target of targets) {
        await assertReplaceable({
          cf,
          workerName: target.workerName,
          recordedVersionIds: target.recordedVersionIds,
          interactive,
          note: "Its secrets change in a new version of what it serves.",
        });
      }
      if (removing) await keepHeldNames(cf, targets, out);

      const versions: Record<string, string | null> = {};
      for (const target of targets) {
        if (Object.keys(target.changes).length === 0) continue;
        try {
          await patchWorkerSecrets(cf, target.workerName, target.changes);
        } catch (error) {
          if (Object.keys(versions).length > 0) {
            out.emit({
              type: "warning",
              code: "SECRETS_PARTIALLY_APPLIED",
              message: `${removing ? "Removed" : "Set"} ${describe(summarize(route, app, versions), removing ? "from" : "on")} before ${target.workerName} failed; run the command again for the rest.`,
              data: { applied: versions },
            });
          }
          throw error;
        }
        const serving = await getWorkerDeployment(cf, target.workerName);
        const versionId = serving?.versionId ?? null;
        if (versionId) await target.record(versionId);
        versions[target.workerName] = versionId;
        out.emit({
          type: "progress",
          step: "secrets",
          message: `${target.workerName}: version ${versionId ?? "unknown"}.`,
        });
      }
      return summarize(route, app, versions, targets);
    } finally {
      await appLease?.release();
    }
  } finally {
    await gatewayLease?.release();
  }
}

/**
 * For `unset`: keep, per target, only the names it holds (a merge patch
 * of null for an absent name would make a version with no change and
 * report a removal that never was), say which it doesn't, and refuse when
 * no target holds any.
 */
async function keepHeldNames(cf: CfRunner, targets: Target[], out: EventSink): Promise<void> {
  let any = false;
  for (const target of targets) {
    const held = await listWorkerSecrets(cf, target.workerName);
    for (const name of Object.keys(target.changes)) {
      if (held.includes(name)) {
        any = true;
        continue;
      }
      delete target.changes[name];
      out.emit({
        type: "warning",
        code: "SECRET_NOT_SET",
        message: `${name} isn't set on ${target.workerName}.`,
      });
    }
  }
  if (!any) {
    throw new EveryAppError(
      "SECRET_NOT_SET",
      `Nothing to remove: ${targets.map((target) => target.workerName).join(", ")} ${
        targets.length === 1 ? "doesn't" : "don't"
      } have the named secrets.`,
    );
  }
}

/** What changed where, from the versions each Worker got. */
function summarize(
  route: Route,
  app: { manifest: EveryAppCliManifest; names: string[]; workerName: string } | null,
  versions: Record<string, string | null>,
  targets: Target[] = [],
): Applied {
  const applied: Applied = {};
  const changed = (workerName: string) => Object.hasOwn(versions, workerName);
  const changedNames = (names: string[], workerNames: string[]) =>
    names.filter((name) =>
      targets.length === 0
        ? true
        : targets.some(
            (target) =>
              workerNames.includes(target.workerName) &&
              changed(target.workerName) &&
              Object.hasOwn(target.changes, name),
          ),
    );
  if (route.gateway.length > 0 && changed(GATEWAY_WORKER_NAME)) {
    applied.gateway = {
      names: changedNames(route.gateway, [GATEWAY_WORKER_NAME]),
      versions: { [GATEWAY_WORKER_NAME]: versions[GATEWAY_WORKER_NAME]! },
    };
  }
  if (app) {
    const appVersions = Object.fromEntries(
      Object.entries(versions).filter(([workerName]) => workerName !== GATEWAY_WORKER_NAME),
    );
    if (Object.keys(appVersions).length > 0) {
      applied.app = {
        id: app.manifest.id,
        workerName: app.workerName,
        names: changedNames(app.names, Object.keys(appVersions)),
        versions: appVersions,
      };
    }
  }
  return applied;
}

/** "X on every-app-gateway, and Y on every-acme-todo and its helper". */
function describe(applied: Applied, preposition = "on"): string {
  const parts: string[] = [];
  if (applied.gateway) {
    parts.push(`${applied.gateway.names.join(", ")} ${preposition} ${GATEWAY_WORKER_NAME}`);
  }
  if (applied.app) {
    const helpers = Object.keys(applied.app.versions).length - 1;
    const where =
      helpers <= 0
        ? Object.keys(applied.app.versions).join(", ")
        : `${applied.app.workerName} and its ${helpers === 1 ? "helper" : `${helpers} helpers`}`;
    parts.push(`${applied.app.names.join(", ")} ${preposition} ${where}`);
  }
  return parts.join(", and ");
}

function doneData(applied: Applied): Record<string, unknown> {
  return {
    ...(applied.gateway ? { gateway: applied.gateway } : {}),
    ...(applied.app ? { app: applied.app } : {}),
  };
}
