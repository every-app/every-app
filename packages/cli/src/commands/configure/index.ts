/**
 * `everyapp configure [app]`: the one command that sets up an app, by
 * walking what its manifest declares. "What are all these names?" is the
 * question `secret set NAME...` leaves a person with; configure answers
 * it setting by setting, linked to the app that needs each.
 *
 * It reads the app's manifest (the registry's, as its last deploy stored
 * it, when the app is named; the everyapp.config.ts here when not) and
 * what is set (cf lists the Gateway Worker's names and the app Worker's),
 * then, at a terminal: says in one line where the values go (a provider's
 * key or a capability's client is a Gateway setting, held once for every
 * app; the app's own secrets go on its Worker), shows each setting with
 * whether it is set (names only, never values), asks for each top-level
 * setting that isn't (a hidden prompt, with why the app needs it, where
 * the key comes from and the setup guide above it; a plain setting's
 * prompt, the Gateway's or one of the app's own `settings`, is visible
 * and checked), then walks each required feature (its name, why and
 * numbered steps, then a prompt per unset value with its `how`; a
 * generated secret is made, and shown once when it must be pasted
 * somewhere; a file's prompt takes its path), asks "Set up <name>?" for
 * each optional feature that's off (or "Finish" one that's incomplete),
 * and sets everything in one go, each name where it
 * belongs, through the secret command's machinery (leases, the
 * replaceable-version check, one Worker version per destination, the
 * app's secret names recorded). An app that is ready asks nothing: it
 * prints the table and the `secret set` that changes a value. It ends by
 * saying whether the app is ready, or what it still needs, and records that on the app's row
 * (`apps.setup_state`, with `app.needs_setup` or `app.ready` on a change).
 *
 * A script or a coding agent can't answer a prompt, so values also come
 * from NAME=value lines on stdin (dotenv syntax: what a command produced,
 * or a file the person wrote) and, with --from-env, from the environment
 * variable of each unset setting's name; never from the command line. A
 * piped name the manifest doesn't declare is refused before anything is
 * written. With nothing to read and something required unset, the run
 * stops with SECRET_VALUE_REQUIRED, like `secret set`. An app that is
 * still not ready at the end gets the APP_NEEDS_SETUP warning `deploy`
 * and `status` give, and `done.data.next` names this command again.
 */
import { text as readAll } from "node:stream/consumers";
import {
  isPlainGatewaySetting,
  type AppSettingsReport,
  type AppSetup,
  type EvaluatedSetting,
  type FeatureReport,
  type ProviderRegistry,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import { generatedSecret } from "@every-app/sdk/internal";
import {
  featureIntro,
  featuresData,
  fileValue,
  fillPlaceholders,
  type FeatureData,
  type SetupUrls,
} from "@/lib/app/features";
import {
  appSetupFrom,
  boundGatewayNames,
  describeUnmet,
  guideLine,
  listAppSecretNames,
  listGatewaySecretNames,
  namesToSet,
  oauthClientsHeld,
  renderSettingsTable,
  settingsRows,
} from "@/lib/app/settings";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { gatewayRegistry, readUploadedClients } from "@/lib/gateway/providers";
import { findRegisteredApp } from "@/lib/gateway/registry";
import { loadEveryAppManifestIfPresent } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import {
  askSecret,
  askText,
  canPromptInTerminal,
  confirmAtTerminal,
  tellPerson,
} from "@/lib/output/prompt";
import { commandLines, factLines, finish as finishResult } from "@/lib/output/result";
import { runCommand } from "@/lib/output/run";
import { listed } from "@/lib/output/text";
import { checkedPlainValue, plainContext, plainValueProblem } from "@/lib/secretValue";
import type { GatewayCommandFlags } from "../flags";
import {
  applyAppSettings,
  doneData,
  ManifestSource,
  storedManifestOf,
  type Applied,
  type SecretsManifest,
} from "../secret";

export interface ConfigureFlags extends GatewayCommandFlags {
  /** Each unset setting's value from the environment variable of its name. */
  "from-env"?: boolean;
}

/** The questions configure asks a person; tests script the answers. */
export interface Prompter {
  /** A credential, typed invisibly; with `optional`, nothing is an answer. */
  secret(question: string, options: { context: string[]; optional: boolean }): Promise<string>;
  /** A plain setting's value, shown as typed and checked. */
  text(
    question: string,
    options: { context: string[]; optional: boolean; validate: (value: string) => string | null },
  ): Promise<string>;
  /** Yes or No, No by default. */
  confirm(question: string, context?: string[]): Promise<boolean>;
}

/** The prompts at a terminal (lib/output/prompt.ts). */
const terminalPrompter: Prompter = {
  secret: (question, { context, optional }) => askSecret(question, { context, optional }),
  text: (question, { context, optional, validate }) =>
    askText(question, {
      context,
      validate: (value) => (optional && !value.trim() ? null : validate(value)),
    }),
  confirm: confirmAtTerminal,
};

/** What the handler takes from the command line, and the seams tests use. */
export interface ConfigureOptions {
  flags: ConfigureFlags;
  out: EventSink;
  /** The app to configure; without one, the app whose everyapp.config.ts is in `cwd`. */
  appId?: string;
  /** The directory whose everyapp.config.ts names the app (default: the working directory). */
  cwd?: string;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** Whether a person is at the terminal (default: canPromptInTerminal). */
  interactive?: boolean;
  prompter?: Prompter;
  /** The environment --from-env reads (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** What was piped in, or null when nothing was (default: stdin when it isn't a terminal). */
  readStdin?: () => Promise<string | null>;
  /** Where the lines before the prompts go (default: the terminal, beside them). */
  tell?: (line: string) => void;
}

export async function configure(flags: ConfigureFlags, appId?: string): Promise<void> {
  await runCommand(flags, (out) => configureApp({ flags, out, appId }));
}

/** The app configure acts on: its manifest, where it came from, and its Worker once deployed. */
interface Target {
  appId: string;
  manifest: SecretsManifest & Parameters<typeof appSetupFrom>[0]["manifest"];
  source: ManifestSource;
  /** The app's Worker and registry row; null before its first deploy. */
  deployed: { workerName: string; rowId: string } | null;
  connection: Awaited<ReturnType<typeof connectToGateway>>;
  /** The catalog and the Gateway's registered providers, which the manifest's capabilities are read against. */
  registry: ProviderRegistry;
  /** The app's and the Gateway's URLs, which a feature's steps and `how` name. */
  urls: SetupUrls;
}

/** What the app needs and what is set, as the settings model reads it now. */
interface State {
  report: AppSettingsReport;
  setup: AppSetup;
  /**
   * The names that are set, each on the Worker that holds it: a setting
   * with several names (an OAuth client) reads unset while one is missing,
   * and only the missing one is asked for or filled.
   */
  held: Set<string>;
}

/**
 * What there is to ask for, from the state: each kind in manifest order,
 * only what can be set now (a Gateway setting always; the app's own once
 * it is deployed) and is known to be unset.
 */
interface Plan {
  /** The top level's required and unset settings: asked for first. */
  required: EvaluatedSetting[];
  /** Each feature, in manifest order, with its own values that are unset and can be set now. */
  features: Array<{ feature: FeatureReport; values: EvaluatedSetting[] }>;
  /** The app's own settings, which wait for its first deploy. */
  afterDeploy: EvaluatedSetting[];
}

export async function configureApp(options: ConfigureOptions): Promise<void> {
  const { out, flags } = options;
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
  const prompter = options.prompter ?? terminalPrompter;
  refuseValueOnCommandLine(options.appId);

  const target = await findTarget(options);
  const before = await readState(target);
  const plan = planOf(before, target);
  if (interactive) {
    for (const line of introduction(target, before)) (options.tell ?? tellPerson)(line);
  }

  // Every value from a script's sources first (each refusal before anything
  // is written), then the prompts for what is still missing. The changes
  // go in manifest order, whatever order they came in.
  const provided = await providedValues(target, before, plan, options);
  const tell = options.tell ?? tellPerson;
  const typed = interactive
    ? await askFor(target, before, plan, provided, prompter, tell)
    : generatedFor(plan, provided, before);
  const changes = inManifestOrder({ ...provided, ...typed }, before);
  const names = Object.keys(changes);

  if (names.length === 0 && !before.setup.ready && !interactive) {
    throw valueRequired(target, before, plan);
  }
  const applied = names.length > 0 ? await applyChanges(target, changes, options) : null;
  // A registered provider's key set here is bound now: read the rows again.
  const after = applied
    ? await readState({
        ...target,
        registry: applied.gateway?.bound?.length
          ? await gatewayRegistry(target.connection.db, target.connection.install)
          : target.registry,
      })
    : before;
  finish(target, after, plan, names, applied, out);
}

/**
 * Apply through the secret command's machinery. A failure after one
 * destination already changed (SECRETS_PARTIALLY_APPLIED) keeps its
 * words and data, but its rerun is this command again: it reads what is
 * set and asks only for what is still missing, from wherever it ran.
 */
async function applyChanges(
  target: Target,
  changes: Readonly<Record<string, string>>,
  options: ConfigureOptions,
): Promise<Applied> {
  try {
    return await applyAppSettings(
      target.connection,
      { manifest: target.manifest, source: target.source, app: target.deployed },
      changes,
      // This app's state is recorded from the state configure reads after; the others' by the refresh.
      {
        ...options,
        ...(target.deployed && target.source === ManifestSource.Registry ? { setupRecordedBy: target.deployed.rowId } : {}),
      },
    );
  } catch (error) {
    if (!(error instanceof EveryAppError) || error.code !== "SECRETS_PARTIALLY_APPLIED") throw error;
    throw new EveryAppError(error.code, error.message, {
      ...rerunOf(target, "to set what is left"),
      retryable: true,
      data: error.data,
    });
  }
}

/**
 * This command again, as it can be run from where it ran: by name once the
 * app is deployed; in the app's directory before that (the name form is
 * refused for an app that isn't deployed).
 */
function rerunOf(target: Target, note: string, flags = ""): { rerun: string; rerunNote: string } {
  return target.deployed
    ? { rerun: `${CLI} configure ${target.appId}${flags}`, rerunNote: note }
    : { rerun: `${CLI} configure${flags}`, rerunNote: `in the app's directory, ${note}` };
}

/** `configure NAME=value`: a value that is in the shell's history already. Nothing is set. */
function refuseValueOnCommandLine(appId: string | undefined): void {
  if (!appId?.includes("=")) return;
  const name = appId.split("=")[0]!;
  throw new EveryAppError(
    "VALUE_ON_COMMAND_LINE",
    `${name}=… looks like a value on the command line, which configure never takes\nIt lands in the shell's history and the process list: rotate it if it was real. Nothing was set.`,
    {
      fix: `pipe NAME=value lines in (one per line), or export ${name} and add --from-env`,
    },
  );
}

/**
 * The app and its manifest: by id from the registry (its deployed
 * manifest, so the command runs from anywhere; refused when it isn't
 * deployed), or the everyapp.config.ts here, deployed or not (before the
 * first deploy, only the Gateway's settings can be set). The Gateway is
 * reached before anything is asked.
 */
async function findTarget(options: ConfigureOptions): Promise<Target> {
  const connect = () =>
    connectToGateway({
      gateway: requestedGatewayUrl(options.flags.gateway),
      accountId: options.flags["account-id"],
      interactive: canPromptInTerminal(options.flags.json ?? false),
      login: { json: options.flags.json, out: options.out, step: "login" },
      createCf: options.createCf,
    });
  if (options.appId) {
    const connection = await connect();
    const found = await findRegisteredApp(connection.db, options.appId);
    // A row left `pending` by a first deploy that never finished has no
    // Worker to read or set: not deployed, as `secret list` and `status` read it.
    if (!found || found.status === "pending") {
      throw new EveryAppError(
        "APP_NOT_FOUND",
        `${options.appId} isn't deployed to this Gateway\nAn app is configured by name after its first deploy; in its directory, configure works before that too (for the Gateway's settings). Nothing was changed.`,
        { rerun: `${CLI} status`, rerunNote: "lists its apps" },
      );
    }
    const manifest = storedManifestOf(found);
    return {
      appId: manifest.id,
      manifest,
      source: ManifestSource.Registry,
      deployed: { workerName: found.workerName, rowId: found.id },
      connection,
      registry: await gatewayRegistry(connection.db, connection.install),
      urls: urlsOf(connection, found.hostname),
    };
  }
  const local = await loadEveryAppManifestIfPresent(options.cwd ?? process.cwd());
  if (!local) {
    throw new EveryAppError(
      "MANIFEST_NOT_FOUND",
      "No everyapp.config.ts in this directory, and no app named",
      { fix: `name the app: ${CLI} configure <app> (${CLI} status lists them), or run this from its directory` },
    );
  }
  const connection = await connect();
  const found = await findRegisteredApp(connection.db, local.id);
  return {
    appId: local.id,
    manifest: local,
    source: ManifestSource.Directory,
    deployed: found && found.status !== "pending" ? { workerName: found.workerName, rowId: found.id } : null,
    connection,
    registry: await gatewayRegistry(connection.db, connection.install),
    urls: urlsOf(connection, found?.hostname || `${local.id}.${connection.install.appBaseDomain}`),
  };
}

/** The URLs `{appUrl}` and `{gatewayUrl}` stand for. */
function urlsOf(connection: Target["connection"], appHostname: string): SetupUrls {
  return { appUrl: `https://${appHostname}`, gatewayUrl: `https://${connection.install.gatewayHost}` };
}

/**
 * The manifest's settings against what the Gateway Worker and the app's
 * own hold now, a registered provider's key counting once it is bound to
 * its row's hosts (as the Gateway reads it).
 */
async function readState(target: Target): Promise<State> {
  const { cf } = target.connection;
  const listed = await listGatewaySecretNames(cf, target.connection.names);
  const gatewayNames = boundGatewayNames(listed, target.registry);
  const secretNames = target.deployed ? await listAppSecretNames(cf, target.deployed.workerName) : null;
  const { report, setup } = appSetupFrom({
    manifest: target.manifest,
    appId: target.appId,
    gatewayNames,
    secretNames,
    lookup: target.registry,
    oauthReady: oauthClientsHeld({
      manifest: target.manifest,
      lookup: target.registry,
      gatewayNames: listed,
      pasted: await readUploadedClients(target.connection.db),
    }),
  });
  const held = new Set<string>();
  for (const setting of report.settings) {
    const names = setting.holder === "gateway" ? gatewayNames : (secretNames ?? []);
    for (const name of [...setting.names, ...setting.alsoReads]) if (names.includes(name)) held.add(name);
  }
  return { report, setup, held };
}

function planOf({ report }: State, target: Target): Plan {
  const settableNow = (setting: EvaluatedSetting) =>
    setting.names.length > 0 && (setting.holder === "gateway" || target.deployed !== null);
  const unset = (setting: EvaluatedSetting) => setting.set === false && settableNow(setting);
  return {
    required: report.settings.filter(
      (setting) => setting.feature === undefined && setting.need.kind === "required" && unset(setting),
    ),
    // A feature's Gateway settings are said, never asked for here: each is its provider's `provider add`.
    features: report.features.map((feature) => ({
      feature,
      values: feature.settings.filter((setting) => setting.holder === "app" && unset(setting)),
    })),
    afterDeploy: report.settings.filter(
      (setting) => setting.holder === "app" && setting.names.length > 0 && target.deployed === null,
    ),
  };
}

/** The one line on where the values go, then each setting with whether it is set. */
function introduction(target: Target, { report }: State): string[] {
  const rows = settingsRows(target.appId, report.settings).map((row) =>
    !target.deployed && row.where === target.appId ? { ...row, status: chalk.dim("after first deploy") } : row,
  );
  return [
    chalk.dim(
      `${target.appId}'s settings are held as the Gateway's secrets: an AI key or a capability's client on the Gateway Worker, once for every app; ${target.appId}'s own secrets and settings on its Worker. Changes are live at once, no deploy needed.`,
    ),
    "",
    ...(rows.length > 0
      ? renderSettingsTable(rows, { app: false })
      : [chalk.dim(`${target.appId} declares no secrets and needs no Gateway settings.`)]),
    "",
  ];
}

/**
 * The setting a name belongs to, whatever its state: one of its names, or
 * one it also reads when set (a capability's optional Gateway settings,
 * RESEND_API_KEY), which a script may pipe in too.
 */
function settingOf({ report }: State, name: string): EvaluatedSetting | undefined {
  return (
    report.settings.find((setting) => setting.names.includes(name)) ??
    report.settings.find((setting) => setting.alsoReads.includes(name))
  );
}

/** `values` keyed in the manifest's order of settings and names: what the steps and the summary say. */
function inManifestOrder(values: Readonly<Record<string, string>>, { report }: State): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const setting of report.settings) {
    for (const name of [...setting.names, ...setting.alsoReads]) {
      if (values[name] !== undefined && ordered[name] === undefined) ordered[name] = values[name];
    }
  }
  return ordered;
}

/**
 * The values a script hands in, each checked before anything is written:
 * NAME=value lines on stdin set every name given (one the manifest
 * doesn't declare, or one of the app's own before its first deploy, is
 * refused; a blank value too), and --from-env fills each unset name from
 * the variable of its name (a name that is set already stays: `secret set
 * NAME --from-env NAME` replaces it on purpose). A plain setting's value
 * is trimmed and checked as `secret set` checks it.
 */
async function providedValues(
  target: Target,
  state: State,
  plan: Plan,
  options: ConfigureOptions,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const checked = (name: string, value: string) => {
    const setting = settingOf(state, name);
    const rule = setting?.value;
    if (setting?.file) return fileValue(value);
    return rule || isPlainGatewaySetting(name) ? checkedPlainValue(name, value, rule) : value;
  };
  // With --from-env, stdin is left alone (as `secret set --from-env` leaves
  // it): a parent that keeps the pipe open would otherwise hold the run.
  const piped = options.flags["from-env"] ? null : await (options.readStdin ?? readPipedStdin)();
  if (piped !== null) {
    for (const { name, value, line } of parsePipedLines(piped)) {
      const setting = settingOf(state, name);
      if (!setting) {
        // A name is echoed only when it looks like one: a bare value that
        // happened to parse (a base64 key ends in `=`) is never shown.
        const shown = /^[A-Z][A-Z0-9_]*$/.test(name) ? name : `line ${line} (not shown: it may be a value)`;
        throw new EveryAppError(
          "SECRET_NOT_DECLARED",
          `${target.appId} doesn't declare ${shown}\nThe piped lines set what its ${target.source === ManifestSource.Registry ? "deployed manifest" : "everyapp.config.ts"} lists (a provider, a capability or one of its secrets). Nothing was set.`,
          { fix: `leave it out, or declare it in everyapp.config.ts${target.source === ManifestSource.Registry ? " and deploy again" : ""}; a bare value goes to ${CLI} secret set NAME` },
        );
      }
      if (setting.holder === "app" && !target.deployed) {
        throw new EveryAppError(
          "APP_NOT_FOUND",
          `${target.appId} isn't deployed yet\nIts own ${name} can be set after its first deploy. Nothing was set.`,
          { rerun: `${CLI} deploy` },
        );
      }
      if (!value.trim()) {
        throw new EveryAppError("SECRET_EMPTY", `${name} is empty in the piped lines`, {
          fix: `give ${name} a value, or leave the line out`,
        });
      }
      values[name] = checked(name, value);
    }
  }
  if (options.flags["from-env"]) {
    const env = options.env ?? process.env;
    const unset = [
      ...plan.required,
      ...plan.features.flatMap((each) => each.values),
      // Every unset Gateway setting, a feature's included: configure never asks for those, a script may give them.
      ...state.report.settings.filter((setting) => setting.holder === "gateway" && setting.set === false),
    ];
    for (const setting of unset) {
      for (const name of setting.names) {
        if (values[name] !== undefined || state.held.has(name)) continue;
        const raw = env[name];
        if (raw === undefined || !raw.trim()) continue;
        values[name] = checked(name, raw);
        options.out.emit({ type: "progress", step: "configure.env", message: `${name} from $${name}` });
      }
    }
  }
  return values;
}

/** What was piped in, or null at a terminal or when nothing was. */
async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const piped = await readAll(process.stdin);
  return piped.trim() ? piped : null;
}

/**
 * The piped lines, one NAME=value each: blank lines and lines starting
 * with `#` are skipped, an `export ` prefix is allowed, one pair of
 * matching quotes around the value is dropped, and the value is otherwise
 * taken as it is (a `#` or an `=` inside it is part of it; a later line
 * for the same name wins). A line that isn't NAME=value is refused
 * without being echoed: it may be a bare value, which goes to
 * `secret set NAME`.
 */
export function parsePipedLines(text: string): Array<{ name: string; value: string; line: number }> {
  const entries: Array<{ name: string; value: string; line: number }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) {
      throw new EveryAppError(
        "PIPED_LINE_INVALID",
        `Line ${index + 1} of the piped input isn't NAME=value\nNothing was set.`,
        { fix: `pipe NAME=value lines, one per line; a bare value goes to ${CLI} secret set NAME` },
      );
    }
    let value = match[2]!.trim();
    const quote = value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) ? value[0] : null;
    if (quote && value.endsWith(quote)) value = value.slice(1, -1);
    entries.push({ name: match[1]!, value, line: index + 1 });
  });
  return entries;
}

/**
 * The secrets a script's run generates (`generate: true`, unset): the
 * top level's and those of every feature that is on (required, started,
 * or given a value now). One a person pastes somewhere (it has a `how`)
 * waits for a terminal, where it is shown, or for a value piped in.
 */
function generatedFor(
  plan: Plan,
  provided: Readonly<Record<string, string>>,
  state: State,
): Record<string, string> {
  const generated: Record<string, string> = {};
  const silent = (setting: EvaluatedSetting) =>
    setting.generate === true && !setting.how && provided[setting.id] === undefined && !state.held.has(setting.id);
  for (const setting of plan.required) if (silent(setting)) generated[setting.id] = generatedSecret();
  for (const { feature, values } of plan.features) {
    const on =
      feature.required ||
      feature.state !== "off" ||
      values.some((setting) => setting.names.some((name) => provided[name] !== undefined));
    if (!on) continue;
    for (const setting of values) if (silent(setting)) generated[setting.id] = generatedSecret();
  }
  return generated;
}

/**
 * The prompts, for what the script's sources didn't cover: each required
 * top-level setting, then each required feature (its intro, then its
 * values), then "Set up <name>?" for each optional feature that's off
 * ("Finish setting up <name>?" for one that's incomplete). Nothing else:
 * a set value is changed on purpose, with `secret set`.
 */
async function askFor(
  target: Target,
  state: State,
  plan: Plan,
  provided: Readonly<Record<string, string>>,
  prompter: Prompter,
  tell: (line: string) => void,
): Promise<Record<string, string>> {
  const typed: Record<string, string> = {};
  const have = (name: string) => provided[name] !== undefined || typed[name] !== undefined || state.held.has(name);
  const ask = async (setting: EvaluatedSetting, optional: boolean) => {
    let first = true;
    for (const name of setting.names) {
      if (have(name)) continue;
      if (setting.generate) {
        typed[name] = generatedSecret();
        // Shown once, at the terminal only, when the person pastes it somewhere.
        if (setting.how) {
          tell(`${name}, generated: ${typed[name]}`);
          tell(chalk.dim(fillPlaceholders(setting.how, target.urls)));
        }
        continue;
      }
      const value = await askValue(name, setting, prompter, { optional, context: first, urls: target.urls });
      first = false;
      if (value) typed[name] = value;
    }
  };
  const walk = async ({ feature, values }: Plan["features"][number], optional: boolean) => {
    for (const line of featureIntro(feature, target.urls, target.registry)) tell(line);
    for (const setting of values) await ask(setting, optional);
  };
  const pending = (each: Plan["features"][number]) =>
    each.values.some((setting) => !setting.names.every(have)) ||
    each.feature.settings.some((setting) => setting.holder === "gateway" && setting.set === false);

  for (const setting of plan.required) await ask(setting, false);
  for (const each of plan.features) {
    if (each.feature.required && pending(each)) await walk(each, false);
  }
  for (const each of plan.features) {
    if (each.feature.required || each.feature.state === "ready" || each.values.length === 0) continue;
    const question =
      each.feature.state === "incomplete" ? `Finish setting up ${each.feature.name}?` : `Set up ${each.feature.name}?`;
    if (await prompter.confirm(question, each.feature.why ? [each.feature.why] : [])) await walk(each, true);
  }
  // A ready app asks nothing more: changing a set value is `secret set`, which finish names.
  return typed;
}

/**
 * One value at the prompt: hidden for a credential, visible and checked
 * for a plain Gateway setting; above it (for a setting's first name) what
 * the setting is for, where its key comes from and its guide, as `status`
 * says them, and what a plain setting takes.
 */
async function askValue(
  name: string,
  setting: EvaluatedSetting,
  prompter: Prompter,
  { optional, context, urls }: { optional: boolean; context: boolean; urls: SetupUrls },
): Promise<string> {
  const guide = guideLine(setting);
  // An app's plain setting is checked against its own entry (`settings`).
  const rule = setting.value;
  // describeUnmet says what an app's plain setting takes; a Gateway one's is said here.
  const lines = context
    ? [...describeUnmet(setting, urls), ...(guide ? [guide] : []), ...(rule ? [] : plainContext(name))]
    : plainContext(name, rule);
  const asked = setting.file ? `${name} (a file's path, or its contents)` : name;
  const question = optional ? `${asked} (Enter to skip)` : asked;
  const value =
    rule || isPlainGatewaySetting(name)
      ? await prompter.text(question, {
          context: lines,
          optional,
          validate: (typed) => plainValueProblem(name, typed, rule),
        })
      : await prompter.secret(question, { context: lines, optional });
  // A file's contents are kept exactly; only the path typed is trimmed.
  return setting.file && value.trim() ? fileValue(value.trim()) : value.trim();
}

/** Nothing to read and something required unset: how a script gets a value in. */
function valueRequired(target: Target, state: State, plan: Plan): EveryAppError {
  const names = [
    ...plan.required,
    ...plan.features.flatMap((each) => (each.feature.required ? each.values : [])),
  ]
    .flatMap((setting) => setting.names)
    .filter((name, index, all) => !state.held.has(name) && all.indexOf(name) === index);
  return new EveryAppError(
    "SECRET_VALUE_REQUIRED",
    `Can't ask for ${target.appId}'s settings without a terminal\n${target.appId} needs ${listed(names)}.\nExport them under those names and add --from-env, or pipe NAME=value lines in.`,
    {
      ...rerunOf(target, "with the variables exported", " --from-env"),
      data: { names, features: featuresData(state.report.features, target.urls, target.registry) },
    },
  );
}

/**
 * The end: what was set, whether the app opens now, and what is still to
 * do. An app that isn't deployed yet can't be ready: once the Gateway's
 * settings it needs are set, the deploy comes next, then this command
 * again for the app's own secrets (which read as unknown until then).
 */
function finish(
  target: Target,
  after: State,
  plan: Plan,
  set: readonly string[],
  applied: Applied | null,
  out: EventSink,
): void {
  const { appId } = target;
  const { setup } = after;
  const waiting = plan.afterDeploy.flatMap((setting) => setting.names);
  const missing = setup.ready ? [] : namesToSet(setup).filter((name) => !after.held.has(name));
  const changed = set.length > 0 ? `Set ${listed(set)}. ` : "";
  const next: Array<{ command: string; note: string }> = [];
  let message: string;
  // What a person reads (docs/cli-output.md): what is so now, then only what is left to do.
  let short: { headline: string; ticked?: boolean; blocks?: string[][] };
  const detail: string[] = [];
  if (!setup.ready) {
    out.emit({
      type: "warning",
      code: "APP_NEEDS_SETUP",
      step: "app.secrets",
      message: `${appId} won't open until ${listed(missing)} ${missing.length === 1 ? "is" : "are"} set`,
      data: { setup },
    });
    next.push(
      target.deployed
        ? { command: `${CLI} configure ${appId}`, note: "at a terminal, with NAME=value lines on stdin, or with --from-env" }
        : { command: `${CLI} configure`, note: "in the app's directory: at a terminal, with NAME=value lines on stdin, or with --from-env" },
    );
    message = `${changed}${appId} still needs ${listed(missing)}`;
    short = { headline: chalk.yellow(`${appId} still needs ${listed(missing)}`), ticked: false };
  } else if (!target.deployed) {
    if (waiting.length > 0) {
      next.push({ command: `${CLI} deploy`, note: `then ${CLI} configure ${appId} for ${listed(waiting)}` });
    } else {
      next.push({ command: `${CLI} deploy`, note: "in the app's directory" });
    }
    message = `${changed}${appId}'s Gateway settings are set${waiting.length > 0 ? `; its own ${listed(waiting)} come after its first deploy` : ""}`;
    short = {
      headline: `${appId}'s Gateway settings are set`,
      blocks: [factLines(waiting.length > 0 ? [{ label: "After its first deploy", value: listed(waiting) }] : [])],
    };
  } else {
    message = `${changed}${appId} is ready`;
    short = { headline: `${appId} is ready` };
    // Nothing asked or set: how a set value is changed, on purpose.
    if (set.length === 0 && after.report.settings.some((setting) => setting.names.length > 0)) {
      short.blocks = [commandLines("Change a value", [`${CLI} secret set <NAME> --app ${appId}`])];
      detail.push("Everything it needs is set.", "A Gateway setting changes for every app.");
    }
  }
  if (set.length > 0) short.blocks = [...(short.blocks ?? []), [chalk.dim("Live now. No deploy needed.")]];
  // An optional feature half set up never blocks, but doesn't work either.
  for (const feature of after.report.features) {
    if (feature.required || feature.state !== "incomplete") continue;
    const unset = feature.settings.filter((setting) => setting.set === false).flatMap((setting) => setting.names);
    out.emit({
      type: "warning",
      code: "FEATURE_INCOMPLETE",
      step: "app.features",
      message: `${feature.name} is half set up: ${listed(unset)} ${unset.length === 1 ? "isn't" : "aren't"} set`,
      data: { feature: feature.id, names: unset },
    });
  }
  const features: FeatureData[] = featuresData(after.report.features, target.urls, target.registry);
  finishResult(out, {
    ...short,
    message: [message],
    detail,
    data: {
      app: { id: appId, deployed: target.deployed !== null, setup },
      features,
      set: [...set],
      ...(applied ? { changed: doneData(applied) } : {}),
      ...(next.length > 0 ? { next } : {}),
    },
  });
}
