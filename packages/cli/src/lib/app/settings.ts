/**
 * The CLI's side of the settings model (`@every-app/sdk/internal`
 * appSettings): what an app's manifest needs set, evaluated against what
 * cf lists on the Gateway Worker and on the app's own, and the one way
 * `status`, `secret list` and the end of `deploy` show it. The gateway
 * evaluates the same model against its env and the registry's record of
 * the app Worker's secret names (`apps.secret_names`), which the CLI
 * writes after listing them here (`listAppSecretNames`).
 */
import type { GatewayNames } from "@every-app/perimeter/manifest";
import {
  appSettings,
  appSetupOf,
  CATALOG,
  evaluateAppSettings,
  featureEntries,
  isReservedAppSecretName,
  oauthClientSource,
  settingValueTakes,
  type AppSettingsReport,
  type CapabilityLookup,
  type AppSetup,
  type AppSetupFeature,
  type AppSetupSetting,
  type EvaluatedSetting,
  type ProviderRegistry,
  type SettingsManifestLike,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { fillPlaceholders, type SetupUrls } from "@/lib/app/features";
import { CLI } from "@/lib/output/command";
import { formatTable } from "@/lib/output/table";

/** The Gateway Worker's secret names: which of its settings are set. `names`: the Gateway's (its Worker). */
export function listGatewaySecretNames(cf: CfRunner, names: Pick<GatewayNames, "worker">): Promise<string[]> {
  return listWorkerSecrets(cf, names.worker);
}

/**
 * The app Worker's own secret names, everyapp's reserved ones (GATEWAY_URL,
 * EVERY_APP_ORG_ID, …) left out: what `apps.secret_names` records.
 */
export async function listAppSecretNames(cf: CfRunner, workerName: string): Promise<string[]> {
  return (await listWorkerSecrets(cf, workerName)).filter((name) => !isReservedAppSecretName(name));
}

/**
 * Where the settings model finds a provider: the catalog alone (`dev`,
 * and before a command connects), or the Gateway's registry with its
 * registered rows (`gatewayRegistry` in lib/gateway/providers.ts), whose
 * unbound rows' settings read as unset.
 */
type SettingsLookup = CapabilityLookup & {
  unboundSettings?(): ReadonlySet<string>;
};

interface AppSetupInput {
  manifest: SettingsManifestLike;
  appId: string;
  /** The Gateway's names; null when cf couldn't list them (every Gateway setting reads as unknown). */
  gatewayNames: readonly string[] | null;
  /** The app Worker's names; null when it has no Worker yet, or cf couldn't list them. */
  secretNames: readonly string[] | null;
  /** The catalog (the default) or the Gateway's registry. */
  lookup?: SettingsLookup;
  /** Whether the Gateway holds each listed OAuth provider's client, by id ({@link oauthClientsHeld}); a provider left out reads by its names. */
  oauthReady?: ReadonlyMap<string, boolean>;
}

interface AppSetupResult {
  report: AppSettingsReport;
  /** The shape every surface returns (`status --json`, `secret list --json`, the gateway's app lists). */
  setup: AppSetup;
}

/**
 * The Gateway's names that count as set: a registered row's key only while
 * it is bound to the hosts and auth the row has now (the Gateway doesn't
 * read it otherwise), as the Gateway's own settings model reads it.
 */
export function boundGatewayNames(
  names: readonly string[],
  lookup: SettingsLookup = CATALOG,
): string[] {
  const unbound = lookup.unboundSettings?.();
  return unbound && unbound.size > 0 ? names.filter((name) => !unbound.has(name)) : [...names];
}

/** The manifest's settings against the names each Worker holds. */
export function appSetupFrom(input: AppSetupInput): AppSetupResult {
  const lookup = input.lookup ?? CATALOG;
  const gatewayNames = input.gatewayNames === null ? null : boundGatewayNames(input.gatewayNames, lookup);
  const report = evaluateAppSettings(
    appSettings(input.manifest, lookup),
    (holder, name) => {
      const names = holder === "gateway" ? gatewayNames : input.secretNames;
      return names === null ? null : names.includes(name);
    },
    {
      features: featureEntries(input.manifest),
      readiness: (setting) => (setting.kind === "capability" ? input.oauthReady?.get(setting.id) : undefined),
    },
  );
  return { report, setup: appSetupOf(report, { cli: CLI, appId: input.appId }) };
}

/**
 * Whether the Gateway holds the client of each OAuth provider the manifest
 * lists, decided as the Gateway decides it (the SDK's `oauthClientSource`):
 * its Worker settings while bound, else the client pasted under Manage
 * workspace → Providers (`oauth_clients`: the CLI reads its binding, never
 * the secret, so it can't tell a copy that no longer opens). A provider
 * whose Worker settings couldn't be listed is left out.
 */
export function oauthClientsHeld(input: {
  manifest: SettingsManifestLike;
  lookup: ProviderRegistry;
  /** The Gateway Worker's setting names, before any binding filter; null when cf couldn't list them. */
  gatewayNames: readonly string[] | null;
  pasted: ReadonlyMap<string, { boundTo: string | null; hasSecret: boolean }>;
}): Map<string, boolean> {
  const held = new Map<string, boolean>();
  if (input.gatewayNames === null) return held;
  const names = input.gatewayNames;
  for (const setting of appSettings(input.manifest, input.lookup)) {
    const capability = setting.kind === "capability" ? input.lookup.get(setting.id) : undefined;
    if (capability?.mode !== "oauth_client") continue;
    const { clientId, clientSecret } = capability.secrets;
    const pasted = input.pasted.get(setting.id);
    const source = oauthClientSource({
      capability,
      envSet: names.includes(clientId) && (!clientSecret || names.includes(clientSecret)),
      envBound: input.lookup.bound(setting.id),
      pasted: pasted ? { ...pasted, opens: true } : null,
    });
    held.set(setting.id, source !== null);
  }
  return held;
}

/** Whether the manifest declares anything to set (a capability with no setting, like members, doesn't count). */
export function declaresSettings(manifest: SettingsManifestLike, lookup: CapabilityLookup = CATALOG): boolean {
  return appSettings(manifest, lookup).some((setting) => setting.names.length > 0);
}

/** Every Gateway name the manifest reads: each setting's names and what it also reads when set. */
export function gatewayNamesRead(manifest: SettingsManifestLike, lookup: CapabilityLookup = CATALOG): string[] {
  const names = new Set<string>();
  for (const setting of appSettings(manifest, lookup)) {
    if (setting.holder !== "gateway") continue;
    for (const name of [...setting.names, ...setting.alsoReads]) names.add(name);
  }
  return [...names];
}

/**
 * One Gateway name an app reads, as `secret list --json`'s
 * `data.gateway.needed` has said it since before the settings model (the
 * setup skills read it): `required` when the app can't do without it
 * (what a setting also reads when set is not), `set` whether the Gateway
 * holds it.
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
 * (required); dim `not set (optional)`; `! not recorded` for an app secret
 * nobody listed yet; `! couldn't check` for a Gateway setting cf couldn't
 * list.
 */
export function settingStatus(setting: Pick<EvaluatedSetting, "set" | "need" | "holder">): string {
  if (setting.set === true) return `${chalk.green("✓")} set`;
  if (setting.set === null) {
    return setting.holder === "app"
      ? `${chalk.yellow("!")} not recorded`
      : `${chalk.yellow("!")} couldn't check`;
  }
  return setting.need.kind === "required" ? NOT_SET : chalk.dim("not set (optional)");
}

/** A feature's state in a word: `✓` when ready, `incomplete` (yellow), `off` (dim). */
function featureStateWord(feature: Pick<AppSetupFeature, "state">): string {
  switch (feature.state) {
    case "ready":
      return chalk.green("✓");
    case "incomplete":
      return chalk.yellow("incomplete");
    case "off":
      return chalk.dim("off");
  }
}

/** One app's features in one line, "GitHub ✓ · Slack off · Sandboxes incomplete"; null without features. */
export function featuresLine(features: readonly Pick<AppSetupFeature, "name" | "state">[]): string | null {
  if (features.length === 0) return null;
  return features.map((feature) => `${feature.name} ${featureStateWord(feature)}`).join(chalk.dim(" · "));
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
 * then where an app's own value lives (its `how`, placeholders filled when
 * `urls` are known), what the key is and where it comes from (the
 * provider's `hint`), what one of the app's plain settings takes ("Takes
 * an http or https URL"), then "Get it at <docs>" when the registry or
 * manifest knows where.
 */
export function describeUnmet(setting: AppSetupSetting, urls?: SetupUrls): string[] {
  const names = setting.names.join(" and ");
  const what = setting.why ?? (setting.label === names ? undefined : names);
  return [
    what ? `${setting.label}: ${what}` : setting.label,
    ...(setting.how ? [urls ? fillPlaceholders(setting.how, urls) : setting.how] : []),
    ...(setting.hint ? [setting.hint] : []),
    // One of the app's plain settings: what its value must be.
    ...(setting.value ? [`Takes ${settingValueTakes(setting.value)}`] : []),
    ...(setting.docs ? [`Get it at ${setting.docs}`] : []),
  ];
}

/**
 * Where the agent docs are served. A setup guide's `setup` ("setup/
 * dataforseo.md") is a path under it, as the Markdown an agent fetches;
 * `everyapp docs setup/dataforseo` prints the same page offline.
 */
export const AGENT_DOCS_URL = "https://everyapp.com/docs/agent";

/** The URL of a setup guide's Markdown, from the `setup` a registry entry names ("setup/dataforseo.md"). */
export function guideUrl(setup: string): string {
  return `${AGENT_DOCS_URL}/${setup.replace(/^\/+/, "")}`;
}

/**
 * Where an agent reads how to set a Gateway setting up: the agent docs'
 * setup guide when the registry names one ("Guide: https://everyapp.com/
 * docs/agent/setup/dataforseo.md"), else for a provider (a
 * registered row has no guide) the command that shows its setup
 * ("Guide: pnpm everyapp provider show stripe"). Null for an app's own
 * value: its feature's steps and its `how` say it.
 */
export function guideLine(setting: Pick<AppSetupSetting, "setup" | "kind" | "id" | "holder">): string | null {
  if (setting.holder === "app") return null;
  if (setting.setup) return `Guide: ${guideUrl(setting.setup)}`;
  if (setting.kind === "capability" || setting.kind === "provider") {
    return `Guide: ${CLI} provider show ${setting.id}`;
  }
  return null;
}

/**
 * Every unmet setting described, and under the first that has one, its
 * guide (see {@link guideLine}), once per distinct guide: two Google
 * clients share setup/google.md.
 */
export function describeUnmetSettings(unmet: readonly AppSetupSetting[]): string[] {
  const guides = new Set<string>();
  return unmet.flatMap((setting) => {
    const lines = describeUnmet(setting);
    const guide = guideLine(setting);
    if (!guide || guides.has(guide)) return lines;
    guides.add(guide);
    return [...lines, guide];
  });
}

/** The names the setup command sets: every required name that is unset, once each. */
export function namesToSet(setup: Pick<AppSetup, "unmet">): string[] {
  return [...new Set(setup.unmet.flatMap((setting) => setting.names))];
}
