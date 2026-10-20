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
 * a secret dropped from the manifest can still be removed). Anything else
 * is refused before anything is read. One call may mix the two; each name
 * goes where it belongs, the Gateway's first.
 *
 * The Gateway is reached and the app found (it must be deployed) before a
 * value is read, so a refusal never costs a typed value. A value comes from
 * a hidden prompt, stdin when something is piped in, or `--from-env VAR`,
 * never the command line. `set` and `unset` change the live Worker and
 * never deploy: every target is checked first (each Worker serves a version
 * everyapp recorded), then one `cf workers secrets bulk` call per Worker
 * (the app's and each of its helpers', or the Gateway's) makes a new
 * version with the change, under the Worker's lease, and that version is
 * recorded as everyapp's own (the app's Worker record, or the install row's
 * `live_version_id`), so the next `deploy` or `setup` replaces it
 * unattended. The secret is live at once. `unset` asks first (`--yes`
 * doesn't), and a name nobody holds is no change. `list` prints names,
 * never values: the app's Workers' (with the names its manifest lists but
 * nobody set yet) and the Gateway settings its providers and capabilities
 * need, or outside an app directory, the Gateway's and what can be set
 * there.
 */
import { stripVTControlCharacters } from "node:util";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import {
  gatewaySettingsFor,
  isDevOnlyGatewaySetting,
  isInstallOwnedGatewaySetting,
  isReservedAppSecretName,
  isSettableGatewaySetting,
  SETTABLE_GATEWAY_SETTINGS,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import type { LocalContext } from "@/context";
import { readOwnedResources, recordUploadedVersion } from "@/lib/app/ownership";
import { assertAppSecretName } from "@/lib/app/secrets";
import type { D1Database } from "@/lib/cf/d1";
import { assertReplaceable } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets, patchWorkerSecrets } from "@/lib/cf/secrets";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { readInstall, writeInstall } from "@/lib/gateway/install";
import { acquireAppLease, acquireGatewayLease, LeasePurpose } from "@/lib/gateway/lease";
import { findRegisteredApp } from "@/lib/gateway/registry";
import { loadEveryAppManifestIfPresent, type EveryAppCliManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmUnlessYes, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import { listed } from "@/lib/output/text";
import { assertOneValueEnough, readSecretValue } from "@/lib/secretValue";
import type { GatewayCommandFlags } from "../flags";

enum SecretAction {
  Set = "set",
  Unset = "unset",
}

/** What the handlers take from the command line, and the seams tests use. */
interface SecretOptions {
  flags: GatewayCommandFlags;
  out: EventSink;
  /** The directory whose everyapp.config.ts names the app (default: the working directory). */
  cwd?: string;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
}

export async function set(
  this: LocalContext,
  flags: GatewayCommandFlags & { "from-env"?: string },
  ...names: string[]
): Promise<void> {
  await runCommand(flags, async (out) => {
    assertOneValueEnough(names, flags["from-env"]);
    await setSecrets({
      flags,
      out,
      names,
      readValue: (name) => readSecretValue(name, { fromEnv: flags["from-env"], json: flags.json }),
    });
  });
}

export async function unset(
  this: LocalContext,
  flags: GatewayCommandFlags & { yes?: boolean },
  ...names: string[]
): Promise<void> {
  await runCommand(flags, (out) => unsetSecrets({ flags, out, names }));
}

export async function list(this: LocalContext, flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => listSecrets({ flags, out }));
}

/** `secret set`: every name routed, the Gateway reached and the app found, then each value read, then the changes applied. */
export async function setSecrets(
  options: SecretOptions & {
    names: string[];
    /** A name's value: the hidden prompt, stdin or `--from-env`. */
    readValue: (name: string) => Promise<string>;
  },
): Promise<void> {
  const { names, out } = options;
  const route = await routeNames(names, options.cwd ?? process.cwd(), SecretAction.Set);
  const reached = await reach(route, options);
  const changes: Record<string, string> = {};
  for (const name of names) changes[name] = await options.readValue(name);
  const applied = (await apply(reached, changes, options, SecretAction.Set))!;
  out.emit({
    type: "done",
    message: `Set ${describe(applied, "on")}`,
    display: chalk.dim(
      applied.app ? "Live now. No deploy needed." : `Live now on ${reached.gatewayHost}. No deploy needed.`,
    ),
    data: doneData(applied),
  });
}

/** `secret unset`: every name routed, then, once the person agrees, removed from the Workers that hold it. */
export async function unsetSecrets(
  options: SecretOptions & {
    names: string[];
    flags: { yes?: boolean };
    /** Whether a person is at the terminal (default: canPromptInTerminal); tests. */
    interactive?: boolean;
    confirm?: Confirm;
  },
): Promise<void> {
  const { names, out } = options;
  const route = await routeNames(names, options.cwd ?? process.cwd(), SecretAction.Unset);
  const reached = await reach(route, options);
  const nothing = () => {
    const message = `${listed(names)} ${names.length === 1 ? "isn't" : "aren't"} set on ${destinationsOf(route).join(" or ")}. Nothing changed.`;
    out.emit({ type: "done", message, display: chalk.dim(message), data: { removed: false } });
  };
  // Whether anything holds them, before asking (checked again under the leases).
  if (!(await holdsAny(reached))) {
    nothing();
    return;
  }
  await confirmUnlessYes({
    yes: options.flags.yes,
    interactive: options.interactive ?? canPromptInTerminal(options.flags.json ?? false),
    confirm: options.confirm,
    question: `Remove ${describe(
      {
        ...(route.gateway.length > 0 ? { gateway: { names: route.gateway, versions: {} } } : {}),
        ...(route.app ? { app: { id: route.app.manifest.id, workerName: "", names: route.app.names, versions: {} } } : {}),
      },
      "from",
    )}?`,
    unattended: "Removing secrets needs confirmation, and there's no terminal to ask in",
    context: route.undeclared.map((name) => `${name} isn't listed in everyapp.config.ts.`),
  });
  const changes = Object.fromEntries(names.map((name) => [name, null]));
  const applied = await apply(reached, changes, options, SecretAction.Unset);
  if (!applied) {
    nothing();
    return;
  }
  out.emit({
    type: "done",
    message: `Removed ${describe(applied, "from")}`,
    display: chalk.dim("Live now. No deploy needed."),
    data: doneData(applied),
  });
}

/** `secret list`: the app's Workers' names and the Gateway settings it needs, or the Gateway's names and what can be set there. */
export async function listSecrets(options: SecretOptions): Promise<void> {
  const { out } = options;
  const manifest = await loadEveryAppManifestIfPresent(options.cwd ?? process.cwd());
  const { cf, db, gatewayUrl } = await connect(options);
  const gatewayNames = await listWorkerSecrets(cf, GATEWAY_WORKER_NAME);
  const settable = [...SETTABLE_GATEWAY_SETTINGS];
  const shown = (display: string, data: Record<string, unknown>) =>
    out.emit({ type: "done", message: stripVTControlCharacters(display), display, data });
  if (!manifest) {
    // What you set, then what setup did, then what you could set.
    const yours = gatewayNames.filter((name) => !isInstallOwnedGatewaySetting(name));
    const setups = gatewayNames.filter((name) => isInstallOwnedGatewaySetting(name));
    const unset = settable.filter((name) => !gatewayNames.includes(name));
    shown(
      [
        chalk.dim(`Gateway secrets · ${gatewayUrl.replace(/^https:\/\//, "")}`),
        "",
        ...formatTable(
          ["NAME", "SET BY"],
          [
            ...yours.map((name) => [name, "you"]),
            ...setups.map((name) => [name, chalk.dim("setup")]),
            ...unset.map((name) => [name, chalk.dim("not set")]),
          ],
        ),
      ].join("\n"),
      { gateway: { workerName: GATEWAY_WORKER_NAME, names: gatewayNames, settable } },
    );
    return;
  }

  const declared = [...(manifest.secrets ?? [])];
  const needs = gatewaySettingsFor(manifest).map((need) => ({
    ...need,
    set: gatewayNames.includes(need.name),
  }));
  const gatewayMissing = needs.filter((need) => need.required && !need.set).map((need) => need.name);

  // The app's Workers, once it is deployed: its own, then each helper.
  const workerName = (await findRegisteredApp(db, manifest.id))?.workerName ?? null;
  const workers: Array<{ workerName: string; names: string[]; missing: string[] }> = [];
  if (workerName) {
    const helpers = (await appWorkerRecords(db, workerName))
      .filter((record) => record.binding !== "")
      .map((record) => record.name);
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
    for (const name of declared) rows.push([name, manifest.id, chalk.dim("after first deploy")]);
  }
  for (const need of needs) {
    rows.push([
      need.name,
      "Gateway",
      need.set ? "set" : need.required ? notSet : chalk.dim("not set (optional)"),
    ]);
  }
  const toSet = [...new Set([...(workers[0]?.missing ?? []), ...gatewayMissing])];
  const next = workerName
    ? toSet.length > 0
      ? [`${CLI} secret set ${toSet.join(" ")}`]
      : []
    : [`${CLI} deploy`];
  shown(
    rows.length > 0
      ? [
          ...formatTable(["NAME", "WHERE", "STATUS"], rows),
          ...(!workerName && declared.length > 0
            ? ["", chalk.dim(`${manifest.id} isn't deployed yet; its own secrets can be set after that.`)]
            : []),
        ].join("\n")
      : chalk.dim(
          `${manifest.id} has no secrets yet. Add one: list it under secrets in everyapp.config.ts, then ${CLI} secret set <name>`,
        ),
    {
      app: { id: manifest.id, deployed: workerName !== null, workerName, declared, workers },
      gateway: {
        workerName: GATEWAY_WORKER_NAME,
        names: gatewayNames,
        needed: needs,
        missing: gatewayMissing,
        settable,
      },
      ...(rows.length > 0 && next.length > 0 ? { next } : {}),
    },
  );
}

/** Where a call's names go, decided from the name list and the manifest alone. */
interface Route {
  gateway: string[];
  app: { manifest: EveryAppCliManifest; names: string[] } | null;
  /** `unset` names the manifest doesn't list (removed anyway). */
  undeclared: string[];
}

/** The destinations as a person knows them: "the Gateway", "analytics". */
function destinationsOf(route: Route): string[] {
  return [...(route.gateway.length > 0 ? ["the Gateway"] : []), ...(route.app ? [route.app.manifest.id] : [])];
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
 * `set`. A name that goes nowhere is refused here, before anything is read.
 */
async function routeNames(names: string[], cwd: string, action: SecretAction): Promise<Route> {
  const gateway = names.filter((name) => isSettableGatewaySetting(name));
  const rest = names.filter((name) => !isSettableGatewaySetting(name));
  if (rest.length === 0) return { gateway, app: null, undeclared: [] };

  const manifest = await loadEveryAppManifestIfPresent(cwd);
  const declared = manifest?.secrets ?? [];
  const undeclared: string[] = [];
  for (const name of rest) {
    const refusal = notRoutable(name, names, manifest, action);
    if (refusal) throw refusal;
    if (!declared.includes(name)) undeclared.push(name);
  }
  return { gateway, app: { manifest: manifest!, names: rest }, undeclared };
}

/**
 * Why a name that isn't a Gateway setting goes nowhere, and what to do
 * instead; null when it is the app's to change.
 */
function notRoutable(
  name: string,
  names: readonly string[],
  manifest: EveryAppCliManifest | null,
  action: SecretAction,
): EveryAppError | null {
  const declared = manifest?.secrets ?? [];
  if (manifest && declared.includes(name)) return null;
  // A Gateway setting typed differently: the command with it.
  const match = closeName(name, [...SETTABLE_GATEWAY_SETTINGS, ...declared]);
  if (match) {
    return new EveryAppError(
      "SECRET_NOT_DECLARED",
      `${name} isn't a Gateway setting${manifest ? ` or one of ${manifest.id}'s secrets` : ""}`,
      {
        rerun: `${CLI} secret ${action} ${names.map((each) => (each === name ? match : each)).join(" ")}`,
        data: { didYouMean: match },
      },
    );
  }
  if (isInstallOwnedGatewaySetting(name) && !manifest) {
    return new EveryAppError(
      "SECRET_NOT_SETTABLE",
      `${name} can't be changed with secret ${action}\n${
        name === "THIRD_PARTY_DEPLOYS"
          ? "It's the hosted Gateway's launch gate, opened by hand."
          : "It's one of the Gateway's own keys, written once by setup."
      }`,
    );
  }
  if (isDevOnlyGatewaySetting(name)) {
    return new EveryAppError(
      "SECRET_NOT_SETTABLE",
      `${name} only works in local development\nA deployed Gateway doesn't read it.`,
      { fix: "set it in the Gateway's .dev.vars" },
    );
  }
  assertAppSecretName(name);
  if (!manifest) {
    return new EveryAppError(
      "SECRET_NOT_DECLARED",
      `${name} isn't a Gateway setting, and there's no app here\nAn app's own secrets are ${action === SecretAction.Set ? "set" : "removed"} from the app's directory (where everyapp.config.ts is).\nGateway settings: ${CLI} secret list`,
      { fix: "cd into the app's directory and run this again" },
    );
  }
  // `unset` takes a name the manifest no longer lists: it may still be set.
  if (action === SecretAction.Unset) return null;
  return new EveryAppError(
    "SECRET_NOT_DECLARED",
    [
      `${manifest.id} doesn't list ${name} as a secret`,
      isInstallOwnedGatewaySetting(name)
        ? `It's one of the Gateway's own keys; listing it under secrets gives ${manifest.id} a secret of its own.`
        : "It isn't a Gateway setting either.",
    ].join("\n"),
    {
      fix: `add it to secrets in everyapp.config.ts: secrets: ${JSON.stringify([...declared, name]).replaceAll(",", ", ")},`,
      rerun: `${CLI} secret set ${name}`,
    },
  );
}

/** A known name that differs from `name` in case or underscores only. */
function closeName(name: string, known: readonly string[]): string | undefined {
  const fold = (value: string) => value.toUpperCase().replace(/_/g, "");
  return known.find((candidate) => candidate !== name && fold(candidate) === fold(name));
}

function connect({ flags, out, createCf }: SecretOptions) {
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

/** The records of the app's Workers: its own (binding "") and each helper's. */
async function appWorkerRecords(db: D1Database, workerName: string) {
  return (await readOwnedResources(db, workerName)).filter((resource) => resource.kind === "worker");
}

/** The Gateway reached, and the app's Worker found, for a call's names. */
interface Reached {
  route: Route;
  cf: CfRunner;
  db: D1Database;
  deployer: Awaited<ReturnType<typeof connect>>["deployer"];
  accountName: string | null;
  /** "apps.example.com". */
  gatewayHost: string;
  app: { manifest: EveryAppCliManifest; names: string[]; workerName: string } | null;
}

/** Connect, and find the app the names go to: refused when it isn't deployed, before any value is read. */
async function reach(route: Route, options: SecretOptions): Promise<Reached> {
  const { cf, db, deployer, accountName, gatewayUrl } = await connect(options);
  let app: Reached["app"] = null;
  if (route.app) {
    const { id } = route.app.manifest;
    const found = await findRegisteredApp(db, id);
    if (!found) {
      throw new EveryAppError(
        "APP_NOT_FOUND",
        `${id} isn't deployed yet\nIts secrets can be set after its first deploy. Nothing was changed.`,
        { rerun: `${CLI} deploy` },
      );
    }
    app = { ...route.app, workerName: found.workerName };
  }
  return { route, cf, db, deployer, accountName, gatewayHost: gatewayUrl.replace(/^https:\/\//, ""), app };
}

/** Whether any Worker the names go to holds one of them. */
async function holdsAny({ cf, db, route, app }: Reached): Promise<boolean> {
  const workers = [
    ...(route.gateway.length > 0 ? [{ workerName: GATEWAY_WORKER_NAME, names: route.gateway }] : []),
    ...(app
      ? (await appWorkerRecords(db, app.workerName)).map((record) => ({ workerName: record.name, names: app.names }))
      : []),
  ];
  for (const { workerName, names } of workers) {
    const held = await listWorkerSecrets(cf, workerName);
    if (names.some((name) => held.includes(name))) return true;
  }
  return false;
}

/** A Worker whose secrets change: what changes there, and how its new version is recorded. */
interface Target {
  workerName: string;
  changes: Record<string, string | null>;
  recordedVersionIds: ReadonlyArray<string | null | undefined>;
  record: (versionId: string) => Promise<void>;
}

/** Where names go, as a person sees it: the Gateway, or the app with its helpers. One step each. */
interface Destination {
  step: "secrets.gateway" | "secrets.app";
  /** "the Gateway", "analytics". */
  shownAs: string;
  names: string[];
  targets: Target[];
}

/**
 * Apply the changes where each name goes, every check before the first
 * change: take the Gateway's lease and then the app's, find the app's
 * Workers, run the replace check on every target (and for `unset`, keep the
 * names each target holds), then patch each destination in turn, the
 * Gateway's first, a step each. A failure after a patch landed says what
 * already changed and reruns only what's left, so no value is asked twice.
 * Returns null for an `unset` none of whose names any target holds.
 */
async function apply(
  reached: Reached,
  changes: Readonly<Record<string, string | null>>,
  options: SecretOptions,
  action: SecretAction,
): Promise<Applied | null> {
  const { out } = options;
  const { cf, db, route, app, deployer } = reached;
  const interactive = canPromptInTerminal(options.flags.json ?? false);
  const pick = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, changes[name] ?? null]));
  const removing = action === SecretAction.Unset;

  const gatewayLease =
    route.gateway.length > 0 ? await acquireGatewayLease({ db, out }, LeasePurpose.GatewaySecrets) : null;
  try {
    const appLease = app
      ? await acquireAppLease(
          { db, out },
          { workerName: app.workerName, appId: app.manifest.id, purpose: LeasePurpose.AppSecrets },
        )
      : null;
    try {
      const destinations: Destination[] = [];
      if (gatewayLease) {
        // Under the lease, the install row is the last deploy's for sure.
        const install = await readInstall(db);
        if (!install) {
          throw new EveryAppError("GATEWAY_NOT_INSTALLED", `The Gateway${reached.accountName ? ` in ${reached.accountName}` : ""} isn't fully installed`, {
            rerun: `${CLI} setup`,
          });
        }
        destinations.push({
          step: "secrets.gateway",
          shownAs: "the Gateway",
          names: route.gateway,
          targets: [
            {
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
            },
          ],
        });
      }
      if (app) {
        const records = await appWorkerRecords(db, app.workerName);
        const recorded = records.map((record) => record.versionId);
        // The app's own Worker first, then each helper deployed with it.
        destinations.push({
          step: "secrets.app",
          shownAs: app.manifest.id,
          names: app.names,
          targets: [
            {
              workerName: app.workerName,
              changes: pick(app.names),
              recordedVersionIds: recorded,
              record: (versionId) => recordUploadedVersion(db, app.workerName, versionId),
            },
            ...records
              .filter((record) => record.binding !== "")
              .map((record) => ({
                workerName: record.name,
                changes: pick(app.names),
                recordedVersionIds: recorded,
                record: (versionId: string) =>
                  recordUploadedVersion(db, app.workerName, versionId, record.binding),
              })),
          ],
        });
      }
      for (const destination of destinations) {
        for (const name of destination.names) {
          out.emit({
            type: "progress",
            step: "secrets.route",
            message: `${name} is ${destination.step === "secrets.gateway" ? "a Gateway setting" : `${destination.shownAs}'s secret`} → Worker ${destination.targets.map((target) => target.workerName).join(", ")}`,
          });
        }
      }

      // Every check, then every change.
      for (const destination of destinations) {
        for (const target of destination.targets) {
          const names = listed(Object.keys(target.changes));
          await assertReplaceable({
            cf,
            workerName: target.workerName,
            shownAs: destination.shownAs,
            recordedVersionIds: target.recordedVersionIds,
            interactive,
            change: removing
              ? { question: `Remove ${names} from it anyway?`, effect: `Removing ${names} creates a new version from it.` }
              : { question: `Set ${names} on it anyway?`, effect: `Setting ${names} creates a new version from it.` },
          });
        }
      }
      if (removing && !(await keepHeldNames(cf, destinations, out))) return null;

      const applied: Applied = {};
      for (const [index, destination] of destinations.entries()) {
        const changing = destination.targets.filter((target) => Object.keys(target.changes).length > 0);
        if (changing.length === 0) continue;
        const names = destination.names.filter((name) =>
          changing.some((target) => Object.hasOwn(target.changes, name)),
        );
        const said = `${removing ? "Removed" : "Set"} ${listed(names)} ${removing ? "from" : "on"} ${destination.shownAs}`;
        out.emit({
          type: "step",
          step: destination.step,
          status: "start",
          message: removing ? "Removing..." : `Updating ${destination.shownAs}...`,
        });
        const versions: Record<string, string | null> = {};
        for (const target of changing) {
          try {
            await patchWorkerSecrets(cf, target.workerName, target.changes);
          } catch (error) {
            const done = Object.values(applied).flatMap((each) => each.names);
            if (done.length === 0) throw error;
            const left = destinations.slice(index).flatMap((each) => each.names);
            throw new EveryAppError(
              "SECRETS_PARTIALLY_APPLIED",
              [
                `Couldn't ${removing ? "remove" : "set"} ${listed(destination.names)} ${removing ? "from" : "on"} ${destination.shownAs}`,
                `Cloudflare said: ${errorMessage(error).split("\n")[0]}`,
                `${listed(done)} ${done.length === 1 ? "is" : "are"} ${removing ? "removed" : "set"}; only ${listed(left)} ${left.length === 1 ? "is" : "are"} left.`,
              ].join("\n"),
              {
                rerun: `${CLI} secret ${action} ${left.join(" ")}`,
                retryable: true,
                data: { applied: doneData(applied), left },
              },
            );
          }
          const serving = await getWorkerDeployment(cf, target.workerName);
          const versionId = serving?.versionId ?? null;
          if (versionId) await target.record(versionId);
          versions[target.workerName] = versionId;
          out.emit({
            type: "progress",
            step: "secrets.version",
            message: `${target.workerName} is now at version ${versionId ?? "unknown"}`,
          });
        }
        if (destination.step === "secrets.gateway") applied.gateway = { names, versions };
        else applied.app = { id: app!.manifest.id, workerName: app!.workerName, names, versions };
        out.emit({
          type: "step",
          step: destination.step,
          status: "ok",
          message: said,
          data: { action, names, versions },
        });
      }
      return applied;
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
 * report a removal that never was), saying with --verbose which it
 * doesn't; false when no target holds any.
 */
async function keepHeldNames(cf: CfRunner, destinations: Destination[], out: EventSink): Promise<boolean> {
  let any = false;
  for (const target of destinations.flatMap((destination) => destination.targets)) {
    const held = await listWorkerSecrets(cf, target.workerName);
    for (const name of Object.keys(target.changes)) {
      if (held.includes(name)) {
        any = true;
        continue;
      }
      delete target.changes[name];
      out.emit({ type: "progress", step: "secrets.held", message: `${name} isn't set on ${target.workerName}` });
    }
  }
  return any;
}

/** "OPENAI_API_KEY on the Gateway, and GITHUB_TOKEN on analytics". */
function describe(applied: Applied, preposition: "on" | "from"): string {
  return [
    ...(applied.gateway ? [`${listed(applied.gateway.names)} ${preposition} the Gateway`] : []),
    ...(applied.app ? [`${listed(applied.app.names)} ${preposition} ${applied.app.id}`] : []),
  ].join(", and ");
}

function doneData(applied: Applied): Record<string, unknown> {
  return {
    ...(applied.gateway ? { gateway: applied.gateway } : {}),
    ...(applied.app ? { app: applied.app } : {}),
  };
}
