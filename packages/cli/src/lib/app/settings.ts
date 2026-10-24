/**
 * The CLI's side of the settings model (`@every-app/sdk/internal`
 * appSettings): what an app's manifest needs set, evaluated against what
 * cf lists on the Gateway Worker and on the app's own, and the one way
 * `status`, `secret list` and the end of `deploy` show it. The gateway
 * evaluates the same model against its env and the registry's record of
 * the app Worker's secret names (`apps.secret_names`), which the CLI
 * writes after listing them here (`listAppSecretNames`).
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import {
  appSettings,
  appSetupOf,
  evaluateAppSettings,
  isReservedAppSecretName,
  type AppSettingsReport,
  type AppSetup,
  type AppSetupSetting,
  type EvaluatedSetting,
  type SettingsManifestLike,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { CLI } from "@/lib/output/command";
import { formatTable } from "@/lib/output/table";

/** The Gateway Worker's secret names: which of its settings are set. */
export function listGatewaySecretNames(cf: CfRunner): Promise<string[]> {
  return listWorkerSecrets(cf, GATEWAY_WORKER_NAME);
}

/**
 * The app Worker's own secret names, everyapp's reserved ones (GATEWAY_URL,
 * EVERY_APP_ORG_ID, …) left out: what `apps.secret_names` records.
 */
export async function listAppSecretNames(cf: CfRunner, workerName: string): Promise<string[]> {
  return (await listWorkerSecrets(cf, workerName)).filter((name) => !isReservedAppSecretName(name));
}

interface AppSetupInput {
  manifest: SettingsManifestLike;
  appId: string;
  /** The Gateway's names; null when cf couldn't list them (every Gateway setting reads as unknown). */
  gatewayNames: readonly string[] | null;
  /** The app Worker's names; null when it has no Worker yet, or cf couldn't list them. */
  secretNames: readonly string[] | null;
}

interface AppSetupResult {
  report: AppSettingsReport;
  /** The shape every surface returns (`status --json`, `secret list --json`, the gateway's app lists). */
  setup: AppSetup;
}

/** The manifest's settings against the names each Worker holds. */
export function appSetupFrom(input: AppSetupInput): AppSetupResult {
  const report = evaluateAppSettings(appSettings(input.manifest), (holder, name) => {
    const names = holder === "gateway" ? input.gatewayNames : input.secretNames;
    return names === null ? null : names.includes(name);
  });
  return { report, setup: appSetupOf(report, { cli: CLI, appId: input.appId }) };
}

/** Whether the manifest declares anything to set (a capability with no setting, like members, doesn't count). */
export function declaresSettings(manifest: SettingsManifestLike): boolean {
  return appSettings(manifest).some((setting) => setting.names.length > 0);
}

/** Every Gateway name the manifest reads: each setting's names and what it also reads when set. */
export function gatewayNamesRead(manifest: SettingsManifestLike): string[] {
  const names = new Set<string>();
  for (const setting of appSettings(manifest)) {
    if (setting.holder !== "gateway") continue;
    for (const name of [...setting.names, ...setting.alsoReads]) names.add(name);
  }
  return [...names];
}

/**
 * One Gateway name an app reads, as `secret list --json`'s
 * `data.gateway.needed` has said it since before the settings model (the
 * setup skills read it): `required` when the app can't do without it
 * (required, or a member of an any-of group; what a setting also reads
 * when set is not), `set` whether the Gateway holds it.
 */
interface GatewayNeed {
  name: string;
  required: boolean;
  set: boolean;
}

/** The Gateway names the settings read, once each in manifest order, required where any setting says so. */
export function gatewayNeeds(
  settings: readonly EvaluatedSetting[],
  gatewayNames: readonly string[],
): GatewayNeed[] {
  const needs = new Map<string, GatewayNeed>();
  const add = (name: string, required: boolean) => {
    const need = needs.get(name);
    if (need) need.required ||= required;
    else needs.set(name, { name, required, set: gatewayNames.includes(name) });
  };
  for (const setting of settings) {
    if (setting.holder !== "gateway") continue;
    for (const name of setting.names) add(name, setting.need.kind !== "optional");
    for (const name of setting.alsoReads) add(name, false);
  }
  return [...needs.values()];
}

/** The unset Gateway names that keep the app from opening (`data.gateway.missing`). */
export function gatewayMissing(
  settings: readonly EvaluatedSetting[],
  gatewayNames: readonly string[],
): string[] {
  return settings
    .filter((setting) => setting.holder === "gateway" && setting.blocking)
    .flatMap((setting) => setting.names)
    .filter((name, index, names) => !gatewayNames.includes(name) && names.indexOf(name) === index);
}

/** One row of a SETTINGS table: one setting of one app. */
export interface SettingsRow {
  app: string;
  /** The setting's names, joined with + when it has several (an OAuth client). */
  setting: string;
  /** "Gateway", the app id, or "<name> helper". */
  where: string;
  status: string;
}

const NOT_SET = `${chalk.yellow("!")} not set`;

/**
 * A setting's state in words, the same everywhere: `✓ set`; `! not set`
 * (required, or every member of its any-of group is unset); dim `not set
 * (optional)`; dim `not set (one of: <group>)` when another member is set;
 * `! not recorded` for an app secret nobody listed yet; `! couldn't check`
 * for a Gateway setting cf couldn't list.
 */
export function settingStatus(setting: Pick<EvaluatedSetting, "set" | "need" | "blocking" | "holder">): string {
  if (setting.set === true) return `${chalk.green("✓")} set`;
  if (setting.set === null) {
    return setting.holder === "app"
      ? `${chalk.yellow("!")} not recorded`
      : `${chalk.yellow("!")} couldn't check`;
  }
  switch (setting.need.kind) {
    case "required":
      return NOT_SET;
    case "optional":
      return chalk.dim("not set (optional)");
    case "anyOf":
      return setting.blocking ? NOT_SET : chalk.dim(`not set (one of: ${setting.need.group})`);
  }
}

/** The SETTING cell: the names, joined with + when there are several. */
function settingName(setting: Pick<EvaluatedSetting, "names">): string {
  return setting.names.join("+");
}

/** The rows of one app's settings, in manifest order; a setting with nothing to set has none. */
export function settingsRows(
  appId: string,
  settings: ReadonlyArray<EvaluatedSetting | AppSetupSetting>,
): SettingsRow[] {
  return settings
    .filter((setting) => setting.names.length > 0)
    .map((setting) => ({
      app: appId,
      setting: settingName(setting),
      where: setting.holder === "gateway" ? "Gateway" : appId,
      status: settingStatus(setting),
    }));
}

/**
 * The rows of one of the app's helper Workers, which shares the app's own
 * secrets: the app-held settings of a report evaluated against the
 * helper's names (`appSetupFrom` with them as `secretNames`, so an any-of
 * group counts as met for the helper by what it, or the Gateway, holds),
 * in the same words as the app's own rows, WHERE "<helper> helper".
 */
export function helperRows(
  appId: string,
  helper: string,
  settings: readonly EvaluatedSetting[],
): SettingsRow[] {
  return settingsRows(
    appId,
    settings.filter((setting) => setting.holder === "app"),
  ).map((row) => ({ ...row, where: `${helper} helper` }));
}

/** The table: APP (unless `app: false`, for one app's own table), SETTING, WHERE, STATUS. */
export function renderSettingsTable(
  rows: readonly SettingsRow[],
  { app = true }: { app?: boolean } = {},
): string[] {
  return app
    ? formatTable(
        ["APP", "SETTING", "WHERE", "STATUS"],
        rows.map((row) => [row.app, row.setting, row.where, row.status]),
      )
    : formatTable(
        ["SETTING", "WHERE", "STATUS"],
        rows.map((row) => [row.setting, row.where, row.status]),
      );
}

/**
 * What an unmet setting is, for whoever sets it: "<label>: <why>" (the
 * names when the manifest says no why and the label doesn't name them),
 * then "Get it at <docs>" when the registry or manifest knows where.
 */
export function describeUnmet(setting: AppSetupSetting): string[] {
  const names = setting.names.join(" and ");
  const what = setting.why ?? (setting.label === names ? undefined : names);
  return [
    what ? `${setting.label}: ${what}` : setting.label,
    ...(setting.docs ? [`Get it at ${setting.docs}`] : []),
  ];
}

/** Where the everyapp skill's setup guides live in an app that has the skill. */
const SKILL_DIR = ".claude/skills/everyapp";

/**
 * Every unmet setting described, and under the first that has one, its
 * setup guide ("Guide: .claude/skills/everyapp/setup/dataforseo.md"), once
 * per distinct guide: two Google clients share setup/google.md.
 */
export function describeUnmetSettings(unmet: readonly AppSetupSetting[]): string[] {
  const guides = new Set<string>();
  return unmet.flatMap((setting) => {
    const lines = describeUnmet(setting);
    if (!setting.setup || guides.has(setting.setup)) return lines;
    guides.add(setting.setup);
    return [...lines, `Guide: ${SKILL_DIR}/${setting.setup}`];
  });
}

/**
 * The names the setup command sets, as `setupCommand` picks them: every
 * required name that is unset, then the first member of each unmet any-of
 * group (one is enough; the command's note names the others).
 */
export function namesToSet(setup: AppSetup): string[] {
  const names: string[] = [];
  const add = (setting: AppSetupSetting) => {
    for (const name of setting.names) if (!names.includes(name)) names.push(name);
  };
  for (const setting of setup.unmet) {
    if (setting.need.kind === "required") add(setting);
  }
  for (const group of setup.groups) {
    if (group.met) continue;
    const first = setup.unmet.find((setting) => setting.id === group.members[0]);
    if (first) add(first);
  }
  return names;
}
