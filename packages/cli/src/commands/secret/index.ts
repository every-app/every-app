/**
 * `everyapp secret set|unset|list`: the app's secrets and the Gateway's
 * settings, each by name, with no flag to say which. (`everyapp configure
 * <app>`, commands/configure, walks an app's manifest instead and sets
 * what it finds through `applyAppSettings` below.)
 *
 * A name that is one of the Gateway's settings (`SETTABLE_GATEWAY_SETTINGS`
 * in `@every-app/sdk/internal`: OPENAI_API_KEY, EMAIL_FROM, the OAuth
 * clients, …) goes to the Gateway Worker, from any directory, and the
 * app's manifest is never read for it. Any other name goes to an app, when
 * its manifest lists it under `secrets` (`unset` takes any name the app
 * could have, so a secret dropped from the manifest can still be removed):
 * the app whose everyapp.config.ts is in the current directory, or with
 * `--app <id>`, the app by that id, whose manifest is the one its last
 * deploy stored in the registry, so the command runs from anywhere (a
 * release deploy has no checkout). Anything else is refused before
 * anything is read. One call may mix the two; each name goes where it
 * belongs, the Gateway's first.
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
 * unattended. After a change to an app's Worker its secret names are
 * recorded on the app's row (`secret_names`), so the gateway knows what is
 * set, and every app the change can move gets its setup state recorded
 * (`apps.setup_state`, with `app.needs_setup` or `app.ready` on a
 * transition: lib/gateway/setupState.ts). The secret is live at once.
 * `unset` asks first (`--yes` doesn't),
 * and a name nobody holds is no change. `list` prints names, never values:
 * one app's settings (the app here, or `list <app>`) as the settings model
 * sees them, set or not, with the one command that opens the app; or
 * outside an app directory, the Gateway's names (what is set, and of the
 * rest only what some app reads) and every app's settings.
 */
import { stripVTControlCharacters } from "node:util";
import { GATEWAY_WORKER_NAME, validateManifest, type Manifest } from "@every-app/perimeter/manifest";
import {
  appSettings,
  appSetupOf,
  evaluateAppSettings,
  isDevOnlyGatewaySetting,
  isHostedOnlyGatewaySetting,
  isInstallOwnedGatewaySetting,
  isReservedAppSecretName,
  isSettableGatewaySetting,
  PROVIDER_APP_TIER,
  secretEntries,
  secretNames,
  SETTABLE_GATEWAY_SETTINGS,
  type AppSetup,
  type SecretEntry,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import { readOwnedResources, recordUploadedVersion } from "@/lib/app/ownership";
import { assertAppSecretName } from "@/lib/app/secrets";
import {
  appSetupFrom,
  declaresSettings,
  gatewayMissing,
  gatewayNamesRead,
  gatewayNeeds,
  describeUnmetSettings,
  helperRows,
  listAppSecretNames,
  listGatewaySecretNames,
  renderSettingsTable,
  settingsRows,
  type SettingsRow,
} from "@/lib/app/settings";
import type { D1Database } from "@/lib/cf/d1";
import { assertReplaceable } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets, patchWorkerSecrets } from "@/lib/cf/secrets";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { readInstall, writeInstall } from "@/lib/gateway/install";
import { acquireAppLease, acquireGatewayLease, LeasePurpose } from "@/lib/gateway/lease";
import { refreshSetupStates } from "@/lib/gateway/setupState";
import {
  bindRemoteMcpCredentials,
  remoteMcpCredentialNames,
  unbindRemoteMcpCredentials,
} from "@/lib/gateway/remoteMcpApps";
import {
  findRegisteredApp,
  listApps,
  readApp,
  writeAppSecretNames,
  type RegisteredAppInfo,
} from "@/lib/gateway/registry";
import { loadEveryAppManifestIfPresent } from "@/lib/manifest";
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

/** The flags `set` and `unset` share: where the Gateway is, and which app a name is for. */
interface SecretFlags extends GatewayCommandFlags {
  /** The app whose secret a name is (default: the app in this directory). */
  app?: string;
}

/** What the handlers take from the command line, and the seams tests use. */
interface SecretOptions {
  flags: SecretFlags;
  out: EventSink;
  /** The directory whose everyapp.config.ts names the app (default: the working directory). */
  cwd?: string;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** The app row whose setup state the caller records itself (`configure`), left out of the refresh. */
  setupRecordedBy?: string;
}

interface SetSecretsOptions extends SecretOptions {
  names: string[];
  /** A name's value: the hidden prompt, stdin or `--from-env`. */
  readValue: (name: string) => Promise<string>;
}

export async function set(
  flags: SecretFlags & { "from-env"?: string },
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
  flags: SecretFlags & { yes?: boolean },
  ...names: string[]
): Promise<void> {
  await runCommand(flags, (out) => unsetSecrets({ flags, out, names }));
}

export async function list(flags: GatewayCommandFlags, appId?: string): Promise<void> {
  await runCommand(flags, (out) => listSecrets({ flags, out, appId }));
}

/** `secret set`: every name routed, the Gateway reached and the app found, then each value read, then the changes applied. */
export async function setSecrets(options: SetSecretsOptions): Promise<void> {
  const { applied, gatewayHost } = await applySecretValues(options);
  // Where each remote MCP credential goes, said every time: the operator sees the origin it was pinned to.
  const pins = (applied.gateway?.pinned ?? []).map(
    ({ name, origin }) => `${name} is sent to ${origin} and nowhere else.`,
  );
  options.out.emit({
    type: "done",
    message: [`Set ${describe(applied, "on")}`, ...pins].join("\n"),
    display: [
      ...pins,
      chalk.dim(applied.app ? "Live now. No deploy needed." : `Live now on ${gatewayHost}. No deploy needed.`),
    ].join("\n"),
    data: doneData(applied),
  });
}

/** Reuse the secret command's checks, leases and version recording inside setup. */
export async function applySecretValues(options: SetSecretsOptions) {
  const reached = await resolve(options.names, options, SecretAction.Set);
  const changes: Record<string, string> = {};
  for (const name of options.names) changes[name] = await options.readValue(name);
  const applied = (await apply(reached, changes, options, SecretAction.Set))!;
  return { applied, gatewayHost: reached.gatewayHost };
}

/**
 * Set or remove Gateway settings from another command (`access setup`,
 * `access off`): the same lease, replaceable-version check, one
 * `cf workers secrets bulk` and version record as `secret set`, for a
 * connection that command already has. `changes` maps each name to its
 * value, or null to remove it. Returns what changed, or null when a removal
 * found nothing to remove.
 */
export async function applyGatewaySettings(
  connection: Pick<Awaited<ReturnType<typeof connectToGateway>>, "cf" | "db" | "deployer" | "accountName" | "gatewayUrl">,
  changes: Readonly<Record<string, string | null>>,
  options: Pick<SecretOptions, "flags" | "out">,
): Promise<Applied | null> {
  const names = Object.keys(changes);
  const removing = Object.values(changes).every((value) => value === null);
  for (const name of names) {
    if (!isSettableGatewaySetting(name)) throw new Error(`${name} isn't a Gateway setting`);
  }
  const reached: Reached = {
    route: { gateway: names, app: null, undeclared: [] },
    cf: connection.cf,
    db: connection.db,
    deployer: connection.deployer,
    accountName: connection.accountName,
    gatewayHost: connection.gatewayUrl.replace(/^https:\/\//, ""),
    app: null,
  };
  return apply(reached, changes, options, removing ? SecretAction.Unset : SecretAction.Set);
}

/**
 * Set an app's settings from `configure`, which already reached the
 * Gateway and found the app: the same routing (a Gateway setting to the
 * Gateway, a name the manifest lists to the app's Workers, anything else
 * refused before a value is used), leases, replaceable-version checks,
 * one `cf workers secrets bulk` per Worker and version records as
 * `secret set`. `app` is null before the app's first deploy: then a name
 * of the app's own is refused with APP_NOT_FOUND, and nothing changes.
 */
export async function applyAppSettings(
  connection: Pick<Awaited<ReturnType<typeof connectToGateway>>, "cf" | "db" | "deployer" | "accountName" | "gatewayUrl">,
  target: {
    manifest: SecretsManifest;
    source: ManifestSource;
    app: { workerName: string; rowId: string } | null;
  },
  changes: Readonly<Record<string, string>>,
  options: Pick<SecretOptions, "flags" | "out" | "setupRecordedBy">,
): Promise<Applied> {
  const route = routeNames(Object.keys(changes), target.manifest, target.source, SecretAction.Set);
  if (route.app && !target.app) {
    throw new EveryAppError(
      "APP_NOT_FOUND",
      `${target.manifest.id} isn't deployed yet\nIts own ${listed(route.app.names)} can be set after its first deploy. Nothing was changed.`,
      { rerun: `${CLI} deploy` },
    );
  }
  const reached: Reached = {
    route,
    cf: connection.cf,
    db: connection.db,
    deployer: connection.deployer,
    accountName: connection.accountName,
    gatewayHost: connection.gatewayUrl.replace(/^https:\/\//, ""),
    app: route.app && target.app ? { ...route.app, ...target.app } : null,
  };
  return (await apply(reached, changes, options, SecretAction.Set))!;
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
  const reached = await resolve(names, options, SecretAction.Unset);
  const { route } = reached;
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
    context: route.undeclared.map((name) =>
      route.app?.source === ManifestSource.Registry
        ? `${name} isn't listed in ${route.app.manifest.id}'s deployed manifest.`
        : `${name} isn't listed in everyapp.config.ts.`,
    ),
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

/** What `secret list [<app>]` takes beyond the shared options. */
interface ListSecretsOptions extends SecretOptions {
  /** The app whose settings to list (default: the app in this directory, else every app). */
  appId?: string;
}

/**
 * `secret list`: one app's settings (the app in this directory, or
 * `<app>`) with what each is set to, and the one command that opens the
 * app; or outside an app directory, the Gateway's names and every app's
 * settings.
 */
export async function listSecrets(options: ListSecretsOptions): Promise<void> {
  const { out } = options;
  const local = options.appId ? null : await loadEveryAppManifestIfPresent(options.cwd ?? process.cwd());
  const { cf, db, gatewayUrl, install } = await connect(options);
  const gatewayNames = await listGatewaySecretNames(cf);
  const settable = [...SETTABLE_GATEWAY_SETTINGS];
  const shown = (display: string, data: Record<string, unknown>) =>
    out.emit({ type: "done", message: stripVTControlCharacters(display), display, data });

  if (!options.appId && !local) {
    // What you set, then what setup did, then, of what you could set, only
    // what some app here reads (the Gateway has dozens of settings; most
    // installs need a few); then each app's settings, for the apps that
    // have any.
    const yours = gatewayNames.filter((name) => !isInstallOwnedGatewaySetting(name));
    const setups = gatewayNames.filter((name) => isInstallOwnedGatewaySetting(name));
    const registered = await listApps(db);
    const read = new Set(registered.flatMap((app) => (app.manifest ? gatewayNamesRead(app.manifest) : [])));
    // The hosted Gateway's own switches: nothing on a self-hosted install reads them.
    const hosted = install.deploymentMode === "hosted";
    const relevant = settable.filter((name) => hosted || !isHostedOnlyGatewaySetting(name));
    const unset = relevant.filter((name) => !gatewayNames.includes(name));
    // The credentials live remote MCP apps declare (`<ID>_MCP_TOKEN`), which
    // no fixed list names: each unset one is listed beside the rest.
    const credentials = await remoteMcpCredentialNames(db);
    const listed = [
      ...unset.filter((name) => read.has(name) || (hosted && isHostedOnlyGatewaySetting(name))),
      ...[...credentials.keys()].filter((name) => !gatewayNames.includes(name)),
    ];
    const more = unset.filter((name) => !listed.includes(name)).length;
    const apps: Array<{ id: string; setup: AppSetup; rows: SettingsRow[] }> = [];
    // An app whose Worker's secrets can't be listed (deleted by hand, say)
    // keeps its rows, its own as not recorded, and is named once below:
    // one Worker never fails the whole list.
    const unlisted: Array<{ id: string; reason: string }> = [];
    for (const app of registered) {
      // A dispatch-tier app's settings the platform doesn't gate.
      if (!app.manifest || !declaresSettings(app.manifest) || app.tier === "dispatch") continue;
      if (app.tier === PROVIDER_APP_TIER) {
        // An MCP app has no Worker of its own: its key or credential is a
        // Gateway setting. Listed only while it needs setup, with the one
        // `secret set` that sets it up (`mcp list` shows them all).
        const report = evaluateAppSettings(appSettings(app.manifest), (holder, name) =>
          holder === "gateway" ? gatewayNames.includes(name) : null,
        );
        if (report.ready) continue;
        const setup = appSetupOf(report, { cli: CLI, appId: app.appSlug, provider: true });
        apps.push({ id: app.appSlug, setup, rows: settingsRows(app.appSlug, report.settings) });
        continue;
      }
      const secretNames =
        app.status === "pending"
          ? null
          : await listAppSecretNames(cf, app.workerName).catch((error: unknown) => {
              unlisted.push({ id: app.appSlug, reason: errorMessage(error).split("\n")[0]! });
              return null;
            });
      const { report, setup } = appSetupFrom({
        manifest: app.manifest,
        appId: app.appSlug,
        gatewayNames,
        secretNames,
      });
      apps.push({ id: app.appSlug, setup, rows: settingsRows(app.appSlug, report.settings) });
    }
    const rows = apps.flatMap((app) => app.rows);
    shown(
      [
        chalk.dim(`Gateway secrets · ${gatewayUrl.replace(/^https:\/\//, "")}`),
        "",
        ...formatTable(
          ["NAME", "SET BY"],
          [
            ...yours.map((name) => [name, "you"]),
            ...setups.map((name) => [name, chalk.dim("setup")]),
            ...listed.map((name) => [name, chalk.dim("not set")]),
          ],
        ),
        ...(more > 0 ? [chalk.dim(`${more} more can be set; see docs/capabilities.md`)] : []),
        ...(rows.length > 0 ? ["", ...renderSettingsTable(rows)] : []),
        ...(unlisted.length > 0 ? [chalk.dim(unlistedNote(unlisted))] : []),
      ].join("\n"),
      {
        gateway: {
          workerName: GATEWAY_WORKER_NAME,
          names: gatewayNames,
          settable,
          // Each remote MCP app credential name, the apps that declare it, and whether it is set.
          mcpCredentials: [...credentials].map(([name, ids]) => ({ name, apps: ids, set: gatewayNames.includes(name) })),
        },
        apps: apps.map(({ id, setup }) => ({ id, setup })),
      },
    );
    return;
  }

  // One app: by id from the registry (its deployed manifest), or the one here.
  const registered = options.appId
    ? await readApp(db, options.appId)
    : await findRegisteredApp(db, local!.id);
  const manifest = options.appId ? storedManifestOf(registered!) : local!;
  const workerName = registered && registered.status !== "pending" ? registered.workerName : null;
  const declared = secretNames(manifest);
  // The app's Workers, once it is deployed: its own, then each helper, with
  // every name each holds (everyapp's own included) and the declared names
  // it lacks: `data.app.workers`, as the setup skills have read it.
  const workers: Array<{ workerName: string; names: string[]; missing: string[] }> = [];
  if (workerName) {
    const helpers = (await appWorkerRecords(db, workerName))
      .filter((record) => record.binding !== "")
      .map((record) => record.name);
    for (const name of [workerName, ...helpers]) {
      const names = await listWorkerSecrets(cf, name);
      workers.push({ workerName: name, names, missing: declared.filter((secret) => !names.includes(secret)) });
    }
  }
  const own = workers[0] ? workers[0].names.filter((name) => !isReservedAppSecretName(name)) : null;
  const { report, setup } = appSetupFrom({ manifest, appId: manifest.id, gatewayNames, secretNames: own });
  const rows = settingsRows(manifest.id, report.settings).map((row) =>
    // Before the first deploy there is no Worker to hold the app's own.
    !workerName && row.where === manifest.id ? { ...row, status: chalk.dim("after first deploy") } : row,
  );
  // Each helper Worker shares the app's secrets: after the app's own rows,
  // the app's own settings against what the helper holds, in the same
  // words (an optional one it lacks is "not set (optional)" there too).
  // everyapp's own names only with --verbose.
  for (const helper of workers.slice(1)) {
    const held = helper.names.filter((name) => !isReservedAppSecretName(name));
    const { report: onHelper } = appSetupFrom({ manifest, appId: manifest.id, gatewayNames, secretNames: held });
    rows.push(...helperRows(manifest.id, helper.workerName.split("--").at(-1)!, onHelper.settings));
  }
  const set = `${chalk.green("✓")} set`;
  if (options.flags.verbose && workers[0]) {
    for (const name of workers[0].names.filter(isReservedAppSecretName)) {
      rows.push({ app: manifest.id, setting: name, where: manifest.id, status: set });
    }
  }
  // What to run: the one configure command while something is unmet. The
  // Gateway's settings can be set from anywhere at any time, the app's own
  // only once its Worker exists, so before the first deploy configure sets
  // the Gateway's and the deploy comes next: the app's own read as unknown
  // until then, which never blocks.
  // By name once deployed; before that, in the app's directory (the name
  // form is refused for an app that isn't deployed).
  const next = workerName
    ? setup.command
      ? [setup.command.command]
      : []
    : [
        ...(setup.command ? [{ command: `${CLI} configure`, note: "in the app's directory" }] : []),
        `${CLI} deploy`,
      ];
  shown(
    rows.length > 0
      ? [
          ...renderSettingsTable(rows, { app: false }),
          // What each unmet setting is and where to get it, as status says
          // it, with the setup guide once per guide.
          ...(setup.unmet.length > 0 ? ["", ...describeUnmetSettings(setup.unmet)] : []),
          ...(!workerName && declared.length > 0
            ? ["", chalk.dim(`${manifest.id} isn't deployed yet; its own secrets can be set after that.`)]
            : []),
        ].join("\n")
      : chalk.dim(`${manifest.id} declares no secrets and needs no Gateway settings.`),
    {
      app: {
        id: manifest.id,
        deployed: workerName !== null,
        workerName,
        declared,
        workers,
        secretNames: own,
        settings: report.settings,
        setup,
      },
      gateway: {
        workerName: GATEWAY_WORKER_NAME,
        names: gatewayNames,
        needed: gatewayNeeds(report.settings, gatewayNames),
        missing: gatewayMissing(report.settings, gatewayNames),
        settable,
      },
      ...(rows.length > 0 && next.length > 0 ? { next } : {}),
    },
  );
}

/** The apps whose Worker's secrets cf couldn't list, once, with what it said the first time. */
function unlistedNote(unlisted: ReadonlyArray<{ id: string; reason: string }>): string {
  const whose = listed(unlisted.map((app) => `${app.id}'s`));
  return `Couldn't list ${whose} secrets. Cloudflare said: ${unlisted[0]!.reason}. They show as not recorded.`;
}

/** Where an app's manifest came from, for what a refusal says about it. */
export enum ManifestSource {
  /** everyapp.config.ts in the working directory. */
  Directory = "directory",
  /** The registry row's, as the app's last deploy stored it (`--app <id>`). */
  Registry = "registry",
}

/** What the secret command reads of a manifest: the app's id and its own secrets. */
export interface SecretsManifest {
  id: string;
  secrets?: ReadonlyArray<string | SecretEntry>;
}

/** Where a call's names go, decided from the name list and the manifest alone. */
interface Route {
  gateway: string[];
  app: { manifest: SecretsManifest; names: string[]; source: ManifestSource } | null;
  /** `unset` names the manifest doesn't list (removed anyway). */
  undeclared: string[];
}

/** The destinations as a person knows them: "the Gateway", "analytics". */
function destinationsOf(route: Route): string[] {
  return [...(route.gateway.length > 0 ? ["the Gateway"] : []), ...(route.app ? [route.app.manifest.id] : [])];
}

/** What one call changed, for its message and `done` data. */
export interface Applied {
  gateway?: {
    names: string[];
    versions: Record<string, string | null>;
    /** Remote MCP credentials among `names`, each with the one origin the Gateway now sends it to. */
    pinned?: Array<{ name: string; origin: string }>;
  };
  app?: {
    id: string;
    workerName: string;
    names: string[];
    versions: Record<string, string | null>;
  };
}

/**
 * Route every name: a Gateway setting goes to the Gateway; anything else
 * needs the app's manifest (read only then, so a Gateway-only call never
 * evaluates it), which must list the name for `set`. A name that goes
 * nowhere is refused here, before anything is read.
 */
function routeNames(
  names: string[],
  manifest: SecretsManifest | null,
  source: ManifestSource,
  action: SecretAction,
): Route {
  const gateway = names.filter((name) => isSettableGatewaySetting(name));
  const rest = names.filter((name) => !isSettableGatewaySetting(name));
  if (rest.length === 0) return { gateway, app: null, undeclared: [] };
  const declared = manifest ? secretNames(manifest) : [];
  const undeclared: string[] = [];
  for (const name of rest) {
    const refusal = notRoutable(name, names, manifest, source, action);
    if (refusal) throw refusal;
    if (!declared.includes(name)) undeclared.push(name);
  }
  return { gateway, app: { manifest: manifest!, names: rest, source }, undeclared };
}

/**
 * Why a name that isn't a Gateway setting goes nowhere, and what to do
 * instead; null when it is the app's to change.
 */
function notRoutable(
  name: string,
  names: readonly string[],
  manifest: SecretsManifest | null,
  source: ManifestSource,
  action: SecretAction,
): EveryAppError | null {
  const declared = manifest ? secretNames(manifest) : [];
  if (manifest && declared.includes(name)) return null;
  const appFlag = source === ManifestSource.Registry && manifest ? ` --app ${manifest.id}` : "";
  // A Gateway setting typed differently: the command with it.
  const match = closeName(name, [...SETTABLE_GATEWAY_SETTINGS, ...declared]);
  if (match) {
    return new EveryAppError(
      "SECRET_NOT_DECLARED",
      `${name} isn't a Gateway setting${manifest ? ` or one of ${manifest.id}'s secrets` : ""}`,
      {
        rerun: `${CLI} secret ${action} ${names.map((each) => (each === name ? match : each)).join(" ")}${appFlag}`,
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
      `${name} isn't a Gateway setting, and there's no app here\nAn app's own secrets are ${action === SecretAction.Set ? "set" : "removed"} from the app's directory (where everyapp.config.ts is), or from anywhere with --app <id>.\nGateway settings: ${CLI} secret list`,
      { fix: "cd into the app's directory and run this again, or add --app <id>" },
    );
  }
  // `unset` takes a name the manifest no longer lists: it may still be set.
  if (action === SecretAction.Unset) return null;
  return new EveryAppError(
    "SECRET_NOT_DECLARED",
    [
      `${manifest.id} doesn't list ${name} as a secret`,
      source === ManifestSource.Registry
        ? `Its deployed manifest (what --app ${manifest.id} reads) doesn't list it, and it isn't a Gateway setting either.`
        : isInstallOwnedGatewaySetting(name)
          ? `It's one of the Gateway's own keys; listing it under secrets gives ${manifest.id} a secret of its own.`
          : "It isn't a Gateway setting either.",
    ].join("\n"),
    {
      fix: `add it to secrets in everyapp.config.ts: ${secretsLine(manifest, name)}${
        source === ManifestSource.Registry ? ` and deploy ${manifest.id} again` : ""
      }`,
      rerun: `${CLI} secret set ${name}${appFlag}`,
    },
  );
}

/**
 * `secrets: ["A", { name: "B", optional: true }, "X"],` as everyapp.config.ts
 * would read it: each entry in its own form, the new one a bare string
 * when every entry is one, else `{ name: "X" }`.
 */
function secretsLine(manifest: SecretsManifest, name: string): string {
  const entries = manifest.secrets ?? [];
  const entry = (each: string | SecretEntry): string =>
    typeof each === "string"
      ? JSON.stringify(each)
      : `{ ${Object.entries(each)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join(", ")} }`;
  const added = entries.every((each) => typeof each === "string")
    ? JSON.stringify(name)
    : `{ name: ${JSON.stringify(name)} }`;
  return `secrets: [${[...entries.map(entry), added].join(", ")}],`;
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

/**
 * The manifest a registered app's row stores, validated as the gateway
 * validates a registration (the lenient schema: a newer CLI's fields pass
 * through), for a command that acts on the app from anywhere.
 */
export function storedManifestOf(app: RegisteredAppInfo): Manifest {
  if (!app.manifest) {
    throw new EveryAppError(
      "MANIFEST_NOT_FOUND",
      `${app.appSlug}'s registry row holds no manifest\nDeploying it again stores one.`,
      { rerun: `${CLI} deploy`, rerunNote: "in the app's directory" },
    );
  }
  try {
    return validateManifest(app.manifest);
  } catch (error) {
    throw new EveryAppError(
      "INVALID_MANIFEST",
      `${app.appSlug}'s deployed manifest can't be read\n${errorMessage(error)}`,
      { rerun: `${CLI} deploy`, rerunNote: "in the app's directory" },
    );
  }
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
  app: {
    manifest: SecretsManifest;
    names: string[];
    workerName: string;
    /** The app's registry row, where its secret names are recorded. */
    rowId: string;
  } | null;
}

/**
 * Route the names and reach what they go to, every refusal before a value
 * is read: a Gateway-only call connects and routes without a manifest;
 * `--app <id>` connects first and routes by the manifest the registry
 * stores for that app (refused when it isn't deployed); otherwise the
 * manifest here routes before anything connects, and the app must be
 * deployed. Given both, `--app` wins and the directory is never read.
 */
async function resolve(names: string[], options: SecretOptions, action: SecretAction): Promise<Reached> {
  const gatewayOnly = names.every((name) => isSettableGatewaySetting(name));
  const appId = options.flags.app;
  const reached = (connected: Awaited<ReturnType<typeof connect>>, route: Route, app: Reached["app"]) => ({
    route,
    cf: connected.cf,
    db: connected.db,
    deployer: connected.deployer,
    accountName: connected.accountName,
    gatewayHost: connected.gatewayUrl.replace(/^https:\/\//, ""),
    app,
  });
  if (gatewayOnly) {
    return reached(await connect(options), routeNames(names, null, ManifestSource.Directory, action), null);
  }
  if (appId) {
    const connected = await connect(options);
    const found = await findRegisteredApp(connected.db, appId);
    if (!found) {
      throw new EveryAppError(
        "APP_NOT_FOUND",
        `${appId} isn't deployed to this Gateway\nAn app's secrets can be set after its first deploy. Nothing was changed.`,
        { rerun: `${CLI} status`, rerunNote: "lists its apps" },
      );
    }
    const stored = storedManifestOf(found);
    const route = routeNames(
      names,
      { id: stored.id, secrets: secretEntries(stored) },
      ManifestSource.Registry,
      action,
    );
    return reached(connected, route, { ...route.app!, workerName: found.workerName, rowId: found.id });
  }
  const manifest = await loadEveryAppManifestIfPresent(options.cwd ?? process.cwd());
  const route = routeNames(names, manifest, ManifestSource.Directory, action);
  const connected = await connect(options);
  const { id } = route.app!.manifest;
  const found = await findRegisteredApp(connected.db, id);
  if (!found) {
    throw new EveryAppError(
      "APP_NOT_FOUND",
      `${id} isn't deployed yet\nIts secrets can be set after its first deploy. Nothing was changed.`,
      { rerun: `${CLI} deploy` },
    );
  }
  return reached(connected, route, { ...route.app!, workerName: found.workerName, rowId: found.id });
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
                // From anywhere but the app's directory, the app's own names need --app.
                rerun: `${CLI} secret ${action} ${left.join(" ")}${
                  app && route.app?.source === ManifestSource.Registry && left.some((name) => app.names.includes(name))
                    ? ` --app ${app.manifest.id}`
                    : ""
                }`,
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
        if (destination.step === "secrets.gateway") {
          // A remote MCP app's credential is pinned to the origin it was set
          // for. The value is live already: a pin that fails is said, and the
          // Gateway pins an unpinned credential to its app's origin on first use.
          const pinned = await pinRemoteMcpCredentials(db, names, removing, deployer.actor, out).catch(
            (error: unknown) => {
              out.emit({
                type: "progress",
                step: "secrets.pin",
                message: `Couldn't record which origin ${listed(names)} ${names.length === 1 ? "is" : "are"} pinned to (${errorMessage(error).split("\n")[0]}); the Gateway pins it on first use`,
              });
              return [];
            },
          );
          applied.gateway = { names, versions, ...(pinned.length > 0 ? { pinned } : {}) };
        } else {
          applied.app = { id: app!.manifest.id, workerName: app!.workerName, names, versions };
          await recordSecretNames(cf, db, app!, out);
        }
        out.emit({
          type: "step",
          step: destination.step,
          status: "ok",
          message: said,
          data: { action, names, versions },
        });
      }
      // Whether each app the change can move opens now, on its row, with
      // app.needs_setup or app.ready on a change (never failing the run).
      await refreshSetupStates(
        { cf, db, deployer },
        { gateway: applied.gateway?.names ?? [], appRowId: applied.app && app ? app.rowId : null, except: options.setupRecordedBy },
        out,
      );
      return applied;
    } finally {
      await appLease?.release();
    }
  } finally {
    await gatewayLease?.release();
  }
}

/**
 * After the Gateway's settings changed: pin each remote MCP app credential
 * among them (`<ID>_MCP_TOKEN`) to the origin of the live MCP app that
 * declares it (`remote_mcp_credentials`), or drop its pin when it was
 * removed. The Gateway sends a credential only to the origin it is pinned
 * to, so a row re-pointed by an owner or admin never takes it elsewhere.
 * Nothing on a Gateway whose D1 predates the table.
 */
async function pinRemoteMcpCredentials(
  db: D1Database,
  names: readonly string[],
  removing: boolean,
  actor: string,
  out: EventSink,
): Promise<Array<{ name: string; origin: string }>> {
  if (removing) {
    for (const name of await unbindRemoteMcpCredentials(db, names)) {
      out.emit({ type: "progress", step: "secrets.pin", message: `${name}'s pin to its MCP server's origin is gone` });
    }
    return [];
  }
  const result = await bindRemoteMcpCredentials(db, names, actor);
  for (const { name, origin } of result.bound) {
    out.emit({ type: "progress", step: "secrets.pin", message: `${name} is pinned to ${origin}` });
  }
  for (const { name, kept } of result.undeclared) {
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_SECRET_UNDECLARED",
      step: "secrets.gateway",
      message: kept
        ? `No MCP app declares ${name} now\nIt stays pinned to ${kept}, where it was set before; the Gateway sends it nowhere else.`
        : `No MCP app declares ${name}\nThe Gateway pins it to the first MCP app that uses it.`,
      data: { name, pinnedTo: kept, fix: `${CLI} mcp add <url> --secret ${name}` },
    });
  }
  for (const { name, origins } of result.ambiguous) {
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_SECRET_AMBIGUOUS",
      step: "secrets.gateway",
      message: `MCP apps at ${listed(origins)} all declare ${name}\nIt isn't pinned to any of them, so the Gateway sends it to none until one is removed.`,
      data: { name, origins, rerun: `${CLI} mcp list`, rerunNote: "names the apps" },
    });
  }
  return result.bound;
}

/**
 * Record the app Worker's secret names on its row once they changed, so
 * the gateway can tell what is set. The change itself is live already: a
 * record that fails is said with --verbose and left to the next `status`,
 * which re-reads every Worker.
 */
async function recordSecretNames(
  cf: CfRunner,
  db: D1Database,
  app: NonNullable<Reached["app"]>,
  out: EventSink,
): Promise<void> {
  try {
    await writeAppSecretNames(db, app.rowId, await listAppSecretNames(cf, app.workerName));
  } catch (error) {
    out.emit({
      type: "progress",
      step: "secrets.record",
      message: `Couldn't record ${app.manifest.id}'s secret names (${errorMessage(error).split("\n")[0]}); ${CLI} status records them`,
    });
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

export function doneData(applied: Applied): Record<string, unknown> {
  return {
    ...(applied.gateway ? { gateway: applied.gateway } : {}),
    ...(applied.app ? { app: applied.app } : {}),
  };
}
