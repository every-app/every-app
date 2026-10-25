/**
 * What an app needs set before it works, and whether it is: the model
 * behind "needs setup" wherever an app is shown (the gateway's home and
 * Admin → Apps, `everyapp status`, `everyapp secret list`, the end of
 * `everyapp deploy`, and what `everyapp configure <app>` walks through).
 *
 * A manifest declares three kinds of setting. An AI provider
 * (`providers`) and a capability (`capabilities`) are the Gateway's: their
 * keys and clients live on the Gateway Worker, set once for every app
 * with `everyapp secret set <NAME>`. The app's own secrets (`secrets`)
 * live on its Worker, set from its directory. Each declaration carries a
 * need: required (the default; the app doesn't open until it is set),
 * optional (the app opens, and the feature says what is missing where it
 * is used), or a member of a named any-of group (the app opens once any
 * member is set; only for an app that picks among the set members at run
 * time). Each may say `why` it is needed and where it comes from
 * (`docs`, an https URL); for providers and capabilities the registries
 * here supply a default.
 *
 * Everything in this module is pure and tenant-neutral: a manifest ships
 * in a release, and what is set is asked of the caller (`isSet`), which
 * reads the Gateway's env, cf's secret list, or the registry's record of
 * the app Worker's secret names.
 */
import {
  CATALOG,
  authSettingNames,
  capabilitySettings,
  type AiProviderCapability,
  type ApiKeyCapability,
  type Capability,
  type CapabilityLookup,
} from "./capabilities.js";
import {
  isInstallOwnedGatewaySetting,
  isSettableGatewaySetting,
} from "./gatewaySettings.js";
import {
  remoteMcpAuthLabel,
  remoteMcpOf,
  remoteMcpSecretOf,
} from "./remoteMcp.js";

/** A provider as `providers` lists it: its id, or an entry with a need. */
export interface ProviderEntry extends SettingNeedFields {
  id: string;
}

/** A secret as `secrets` lists it: its name, or an entry with a need. */
export interface SecretEntry extends SettingNeedFields {
  name: string;
}

/** What any declaration may say about its need. */
export interface SettingNeedFields {
  /** Why the app needs it, for whoever sets it (200 characters at most). */
  why?: string;
  /** Where the key or client comes from: an https URL. */
  docs?: string;
  /** The app works without it; the feature using it says so where it is used. */
  optional?: boolean;
  /**
   * For an app's own secret: its setup guide, relative to the everyapp
   * skill (`setup/main-secret.md`). Providers and capabilities take theirs
   * from the registries and can't override it.
   */
  setup?: string;
  /**
   * The name of a group of which one set member is enough ("AI model").
   * Only for an app that picks among the set members at run time: the
   * gateway refuses a call to a provider whose key isn't set, whichever
   * others are.
   */
  anyOf?: string;
}

/** The manifest fields this module reads, as a stored or authored manifest has them. */
export interface SettingsManifestLike {
  readonly providers?: ReadonlyArray<string | ProviderEntry>;
  readonly capabilities?: { readonly [id: string]: unknown };
  readonly secrets?: ReadonlyArray<string | SecretEntry>;
  readonly ai?: { readonly routes?: readonly string[] };
  /** A remote MCP app's registration (./remoteMcp.ts): its credential is a required Gateway setting. */
  readonly remote?: unknown;
  readonly name?: string;
}

export type SettingKind =
  | "provider"
  | "capability"
  | "secret"
  | "ai-routes"
  /** A remote MCP app's credential (./remoteMcp.ts): one Gateway setting named by the row. */
  | "remote-mcp";

/** Which Worker holds a setting: the Gateway's, or the app's own. */
export type SettingHolder = "gateway" | "app";

export type SettingNeed =
  | { kind: "required" }
  | { kind: "optional" }
  | { kind: "anyOf"; group: string };

/** One thing the app needs set, as the manifest declares it. */
export interface AppSetting {
  kind: SettingKind;
  /** The provider id, capability id or secret name; "ai-routes" for the AI proxy's extra routes. */
  id: string;
  /** "OpenRouter", "DataForSEO", "MAIN_SECRET", "AI proxy routes". */
  label: string;
  holder: SettingHolder;
  /** Every one of these must be set for the setting to count as set. */
  names: string[];
  /** Read when set, never required (a capability's optional settings). */
  alsoReads: string[];
  need: SettingNeed;
  why?: string;
  docs?: string;
  /**
   * The everyapp skill's setup guide for it, relative to the skill
   * (`setup/dataforseo.md`; in an app `.claude/skills/everyapp/setup/…`, in
   * the checkout `packages/cli/skills/everyapp/setup/…`): what an agent
   * reads to set it up end to end. From the registries for providers and
   * capabilities; from the manifest entry for an app's own secret.
   */
  setup?: string;
  /**
   * What the key is and where it comes from, in a sentence or three, from
   * the provider's entry (its `hint`, and each secret's own after it):
   * what the "Needs setup" dialog, `everyapp status` and `everyapp
   * configure` show beside `why`. A provider registered on the gateway
   * has no guide, so this is what an agent reads for it.
   */
  hint?: string;
}

/** A setting with whether it is set, and whether that keeps the app closed. */
export interface EvaluatedSetting extends AppSetting {
  /**
   * True: every name is set. False: one isn't. Null: not known (an app
   * Worker whose secret names were never recorded), which never blocks.
   */
  set: boolean | null;
  /** This setting keeps the app from opening: required and unset, or a member of an any-of group none of whose members is set. */
  blocking: boolean;
}

/** An any-of group: met once any member is set. */
export interface AnyOfGroup {
  group: string;
  members: EvaluatedSetting[];
  met: boolean;
}

/** What `evaluateAppSettings` finds: whether the app opens, and every setting's state. */
export interface AppSettingsReport {
  /** No required setting is unset and every any-of group is met. */
  ready: boolean;
  /** Every setting, in manifest order: providers, capabilities, the AI routes, secrets. */
  settings: EvaluatedSetting[];
  groups: AnyOfGroup[];
  /** The settings that keep the app closed, in manifest order. */
  unmet: EvaluatedSetting[];
}

/** The need an entry declares; required unless it says otherwise. */
export function needOf(entry: SettingNeedFields | undefined): SettingNeed {
  if (!entry) return { kind: "required" };
  if (typeof entry.anyOf === "string" && entry.anyOf.trim()) {
    return { kind: "anyOf", group: entry.anyOf.trim() };
  }
  if (entry.optional === true) return { kind: "optional" };
  return { kind: "required" };
}

function needFields(entry: unknown): SettingNeedFields {
  if (!entry || typeof entry !== "object") return {};
  const record = entry as Record<string, unknown>;
  return {
    ...(typeof record["why"] === "string" ? { why: record["why"] } : {}),
    ...(typeof record["docs"] === "string" ? { docs: record["docs"] } : {}),
    ...(typeof record["optional"] === "boolean"
      ? { optional: record["optional"] }
      : {}),
    ...(typeof record["setup"] === "string" ? { setup: record["setup"] } : {}),
    ...(typeof record["anyOf"] === "string" ? { anyOf: record["anyOf"] } : {}),
  };
}

/** The providers the manifest lists, each as an entry whatever form it took. */
export function providerEntries(
  manifest: Pick<SettingsManifestLike, "providers">,
): ProviderEntry[] {
  return (manifest.providers ?? []).flatMap((entry) => {
    if (typeof entry === "string") return [{ id: entry }];
    if (entry && typeof entry === "object" && typeof entry.id === "string") {
      return [{ id: entry.id, ...needFields(entry) }];
    }
    return [];
  });
}

/** The provider ids the manifest lists, in order. */
export function providerIds(
  manifest: Pick<SettingsManifestLike, "providers">,
): string[] {
  return providerEntries(manifest).map((entry) => entry.id);
}

/** The app's own secrets the manifest lists, each as an entry whatever form it took. */
export function secretEntries(
  manifest: Pick<SettingsManifestLike, "secrets">,
): SecretEntry[] {
  return (manifest.secrets ?? []).flatMap((entry) => {
    if (typeof entry === "string") return [{ name: entry }];
    if (entry && typeof entry === "object" && typeof entry.name === "string") {
      return [{ name: entry.name, ...needFields(entry) }];
    }
    return [];
  });
}

/** The names of the app's own secrets, in order. */
export function secretNames(
  manifest: Pick<SettingsManifestLike, "secrets">,
): string[] {
  return secretEntries(manifest).map((entry) => entry.name);
}

/**
 * The Gateway settings an AI provider needs, the install's left out (set
 * already). A catalog provider's names are settable by definition; a
 * registered row's are its own, so they count too.
 */
function providerNames(capability: AiProviderCapability): string[] {
  return capabilitySettings(capability).filter(
    (name) => !isInstallOwnedGatewaySetting(name),
  );
}

/** A capability's Gateway settings: what it needs, and what it also reads. */
function capabilityNames(capability: Capability): {
  names: string[];
  alsoReads: string[];
} {
  const settable = (names: readonly string[]) =>
    names.filter(
      (name) =>
        isSettableGatewaySetting(name) && !isInstallOwnedGatewaySetting(name),
    );
  switch (capability.mode) {
    case "api_key":
      return { names: [...capabilitySettings(capability)], alsoReads: [] };
    case "ai":
      return { names: providerNames(capability), alsoReads: [] };
    case "service":
      return {
        names: settable(capability.settings),
        alsoReads: settable(capability.optionalSettings),
      };
    case "oauth_client": {
      const names = [
        capability.secrets.clientId,
        ...(capability.secrets.clientSecret
          ? [capability.secrets.clientSecret]
          : []),
      ];
      const host = capability.hostSetting ? [capability.hostSetting] : [];
      // An instance setting with a default is read when set; without one
      // the provider has no origin until it is set.
      return capability.defaultOrigin
        ? { names, alsoReads: host }
        : { names: [...names, ...host], alsoReads: [] };
    }
  }
}

/**
 * Where a capability's key or client comes from, when the registry knows:
 * an API-key provider's access page, or an OAuth client's console (a path
 * on the default instance for a provider with no fixed host).
 */
function capabilityDocs(capability: Capability): string | undefined {
  switch (capability.mode) {
    case "api_key":
    case "ai":
      return capability.docs;
    case "oauth_client":
      if (capability.console.startsWith("https://")) return capability.console;
      return capability.defaultOrigin
        ? `${capability.defaultOrigin}${capability.console}`
        : undefined;
    case "service":
      return undefined;
  }
}

/** What a provider's entry says about getting its key: its hint, then each setting's own, named when there are several. */
function providerHint(
  capability: Capability,
  names: readonly string[],
): { hint?: string } {
  if (capability.mode === "service" || capability.mode === "oauth_client") {
    return {};
  }
  const details = capability.secrets ?? [];
  const lines = [
    ...(capability.hint ? [capability.hint] : []),
    ...details
      .filter((detail) => detail.hint && names.includes(detail.name))
      .map((detail) =>
        names.length > 1 ? `${detail.name}: ${detail.hint}` : detail.hint!,
      ),
  ];
  return lines.length > 0 ? { hint: lines.join(" ") } : {};
}

function withNeed(
  setting: Omit<AppSetting, "need" | "why" | "docs" | "setup">,
  entry: SettingNeedFields | undefined,
  defaults: { docs?: string; setup?: string; hint?: string } = {},
): AppSetting {
  const docs = entry?.docs ?? defaults.docs;
  // The registry's guide for a Gateway setting; the manifest's for the app's own secret.
  const setup = setting.holder === "gateway" ? defaults.setup : entry?.setup;
  return {
    ...setting,
    need: needOf(entry),
    ...(entry?.why ? { why: entry.why } : {}),
    ...(docs ? { docs } : {}),
    ...(setup ? { setup } : {}),
    ...(defaults.hint ? { hint: defaults.hint } : {}),
  };
}

/**
 * Every setting the manifest declares, in manifest order: its AI
 * providers, its capabilities, the AI proxy's extra routes when `ai.routes`
 * asks for any, then the app's own secrets. A provider or capability the
 * gateway doesn't offer contributes nothing (the manifest validator refuses
 * it elsewhere); so does a capability with nothing to set (`members`),
 * which is always set. `lookup` is where ids are found: the catalog alone
 * by default, or a gateway's registry with its registered rows.
 */
export function appSettings(
  manifest: SettingsManifestLike,
  lookup: CapabilityLookup = CATALOG,
): AppSetting[] {
  const settings: AppSetting[] = [];
  for (const entry of providerEntries(manifest)) {
    const capability = lookup.get(entry.id);
    if (capability?.mode !== "ai") continue;
    const names = providerNames(capability);
    settings.push(
      withNeed(
        {
          kind: "provider",
          id: entry.id,
          label: capability.label,
          holder: "gateway",
          names,
          alsoReads: [],
        },
        entry,
        {
          docs: capability.docs,
          setup: capability.setup,
          ...providerHint(capability, names),
        },
      ),
    );
  }
  for (const [id, entry] of Object.entries(manifest.capabilities ?? {})) {
    const capability = lookup.get(id);
    // An AI provider under `capabilities` is the validator's to refuse.
    if (!capability || capability.mode === "ai") continue;
    const { names, alsoReads } = capabilityNames(capability);
    settings.push(
      withNeed(
        {
          kind: "capability",
          id,
          label: capability.label,
          holder: "gateway",
          names,
          alsoReads,
        },
        needFields(entry),
        {
          docs: capabilityDocs(capability),
          setup: capability.setup,
          ...providerHint(capability, names),
        },
      ),
    );
  }
  if (manifest.ai?.routes?.length) {
    settings.push({
      kind: "ai-routes",
      id: "ai-routes",
      label: "AI proxy routes",
      holder: "gateway",
      names: ["AI_PROXY_EXTRA_ROUTES"],
      alsoReads: [],
      need: { kind: "required" },
      why: `Lets the app call ${manifest.ai.routes.join(", ")} through the AI proxy.`,
      setup: "setup/openai.md",
    });
  }
  const remote = remoteMcpOf(manifest);
  if (remote) {
    const secret = remoteMcpSecretOf(remote.auth);
    if (secret) {
      const label =
        typeof manifest.name === "string" && manifest.name.trim()
          ? manifest.name.trim()
          : "the MCP server";
      settings.push({
        kind: "remote-mcp",
        id: secret,
        label: `${label} credential`,
        holder: "gateway",
        names: [secret],
        alsoReads: [],
        need: { kind: "required" },
        why: `What ${label} expects: ${remoteMcpAuthLabel(remote.auth)}. The Gateway sends it to ${remote.url} and nowhere else.`,
        setup: "setup/remote-mcp.md",
      });
    }
  }
  for (const entry of secretEntries(manifest)) {
    settings.push(
      withNeed(
        {
          kind: "secret",
          id: entry.name,
          label: entry.name,
          holder: "app",
          names: [entry.name],
          alsoReads: [],
        },
        entry,
      ),
    );
  }
  return settings;
}

/** Whether each name of `setting` is set: all → true, one unset → false, else unknown. */
function settingIsSet(
  setting: AppSetting,
  isSet: (holder: SettingHolder, name: string) => boolean | null,
): boolean | null {
  let unknown = false;
  for (const name of setting.names) {
    const state = isSet(setting.holder, name);
    if (state === false) return false;
    if (state === null) unknown = true;
  }
  return unknown ? null : true;
}

export interface EvaluateOptions {
  /**
   * A capability's own readiness rule, where names alone don't say (the
   * gateway's email is configured once a sender parses and a provider is
   * selectable): a boolean or null overrides the names; undefined defers
   * to them.
   */
  readiness?: (setting: AppSetting) => boolean | null | undefined;
}

/**
 * Every setting against what is set. `isSet` answers per holder and name:
 * true, false, or null when it can't tell (the registry never recorded
 * the app Worker's secret names), which never blocks. An any-of group is
 * met once any member is set; while none is and none is unknown, every
 * member blocks.
 */
export function evaluateAppSettings(
  settings: readonly AppSetting[],
  isSet: (holder: SettingHolder, name: string) => boolean | null,
  options: EvaluateOptions = {},
): AppSettingsReport {
  const evaluated: EvaluatedSetting[] = settings.map((setting) => {
    const ready = options.readiness?.(setting);
    return {
      ...setting,
      set: ready === undefined ? settingIsSet(setting, isSet) : ready,
      blocking: false,
    };
  });
  const groups: AnyOfGroup[] = [];
  for (const setting of evaluated) {
    if (setting.need.kind !== "anyOf") continue;
    const group = setting.need.group;
    let found = groups.find((each) => each.group === group);
    if (!found) {
      found = { group, members: [], met: false };
      groups.push(found);
    }
    found.members.push(setting);
  }
  for (const group of groups) {
    group.met = group.members.some((member) => member.set === true);
    const unknown = group.members.some((member) => member.set === null);
    if (!group.met && !unknown) {
      for (const member of group.members) member.blocking = true;
    }
  }
  for (const setting of evaluated) {
    if (setting.need.kind === "required" && setting.set === false) {
      setting.blocking = true;
    }
  }
  const unmet = evaluated.filter((setting) => setting.blocking);
  return { ready: unmet.length === 0, settings: evaluated, groups, unmet };
}

/** The one command that opens the app. */
export interface SetupCommand {
  /**
   * `everyapp configure <app>`: asks for every required setting the app
   * lacks, then offers the optional ones, and sets each where it is held.
   */
  command: string;
}

/**
 * What to run for an app that needs setup: `everyapp configure <app>`,
 * which reads the app's manifest (from the registry, so it runs from
 * anywhere), prompts for each unmet setting (one member of an any-of group
 * is enough: it asks which) and sets them where they are held. Null when
 * the app is ready. `cli` is how the operator runs everyapp (`pnpm
 * everyapp` from a checkout). Scripts that set one name at a time use
 * `everyapp secret set NAME [--app <id>]` instead.
 *
 * A provider app (`provider`: the gateway's own, with no Worker and no
 * directory; `everyapp provider on <id>`) has nothing to configure: its
 * command is the `secret set` of its Gateway key (the first member of an
 * unmet any-of group), as `provider list` says it.
 */
export function setupCommand(
  report: Pick<AppSettingsReport, "unmet" | "groups">,
  {
    cli,
    appId,
    provider = false,
  }: { cli: string; appId: string; provider?: boolean },
): SetupCommand | null {
  if (report.unmet.length === 0) return null;
  if (!provider) return { command: `${cli} configure ${appId}` };
  const names: string[] = [];
  const add = (setting: EvaluatedSetting) => {
    for (const name of setting.names)
      if (!names.includes(name)) names.push(name);
  };
  for (const setting of report.unmet) {
    if (setting.need.kind === "required") add(setting);
  }
  for (const group of report.groups) {
    const first = group.members.find((member) => member.blocking);
    if (first) add(first);
  }
  return { command: `${cli} secret set ${names.join(" ")}` };
}

/** One setting as `AppSetup` carries it: the evaluation without what only the CLI reads. */
export type AppSetupSetting = Omit<EvaluatedSetting, "alsoReads">;

/**
 * An app's setup state as every surface shows it, the same on the
 * gateway's app lists (`setup`), `everyapp status --json`
 * (`apps[].setup`) and `everyapp secret list --json`: whether it opens,
 * every setting with its state, the any-of groups, and the one command
 * that opens it, `everyapp configure <app>` (null when it is ready, or
 * when whoever reads this can't run it: a shared app seen from another
 * organization).
 */
export interface AppSetup {
  ready: boolean;
  settings: AppSetupSetting[];
  unmet: AppSetupSetting[];
  groups: Array<{ group: string; met: boolean; members: string[] }>;
  command: SetupCommand | null;
}

export function appSetupOf(
  report: AppSettingsReport,
  options: {
    cli: string;
    appId: string;
    withCommand?: boolean;
    provider?: boolean;
  },
): AppSetup {
  const strip = ({ alsoReads: _alsoReads, ...setting }: EvaluatedSetting) =>
    setting;
  return {
    ready: report.ready,
    settings: report.settings.map(strip),
    unmet: report.unmet.map(strip),
    groups: report.groups.map((group) => ({
      group: group.group,
      met: group.met,
      members: group.members.map((member) => member.id),
    })),
    command:
      options.withCommand === false ? null : setupCommand(report, options),
  };
}

/** The provider registry's labels, for anything that names a provider to a person. */
export function providerLabel(
  id: string,
  lookup: CapabilityLookup = CATALOG,
): string {
  return lookup.get(id)?.label ?? id;
}

/** The capability `id` names in `lookup`, as an API-key provider, or undefined. */
export function apiKeyCapabilityOf(
  id: string,
  lookup: CapabilityLookup = CATALOG,
): ApiKeyCapability | undefined {
  const capability = lookup.get(id);
  return capability?.mode === "api_key" ? capability : undefined;
}
