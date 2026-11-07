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
 * live on its Worker, set from its directory. Everything the manifest
 * lists at its top level is required: the app doesn't open until it is
 * set. The rest is grouped into features (`features`): each a named set of
 * secrets, settings and the Gateway capabilities and providers it needs,
 * with numbered setup steps. A required feature's values are required; an
 * optional feature is all or nothing, never blocking: off while none of
 * its own values is set, incomplete while some are, ready once all are.
 * Each declaration may say `why` it is needed, where it comes from
 * (`docs`, an https URL) and, for an app's own value, `how` to get it;
 * for providers and capabilities the registries here supply a default. An
 * app's plain settings (`settings`: a host, a project id, a region) are
 * held like its secrets, on its Worker, but are values rather than keys:
 * each says what it takes (a URL, a number, one of a list) and may give a
 * default.
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
  aiDefaultSetupHint,
  aiRequiredSettings,
  resolveAiDefault,
  type IsSet,
} from "./aiDefault.js";
import {
  isInstallOwnedGatewaySetting,
  isSettableGatewaySetting,
} from "./gatewaySettings.js";
import { oauthSetupGuide } from "./oauthPresets.js";
import { hasRemoteMcpBlock, remoteMcpBlockProblem } from "./remoteMcp.js";

/** A provider as `providers` lists it: its id, or an entry with why and docs. */
export interface ProviderEntry extends SettingNeedFields {
  id: string;
}

/** Where one of the app's own values comes from, for whoever sets it. */
export interface OwnValueFields {
  /** Where the value lives and what permission it needs (200 characters at most); may hold `{appUrl}` and `{gatewayUrl}`. */
  how?: string;
  /**
   * The feature the value belongs to (its `features` key); absent for one
   * the manifest lists at its top level.
   */
  feature?: string;
}

/** A secret as `secrets` (or a feature's `secrets`) lists it: its name, or an entry. */
export interface SecretEntry extends SettingNeedFields, OwnValueFields {
  name: string;
  /** `everyapp configure` (and the deploy, for a top-level one) makes it: 32 random bytes, base64url. */
  generate?: boolean;
  /** The value is a file's contents (a .pem): the prompt takes a path. */
  file?: boolean;
}

/** What a plain setting's value is: text by default, or a URL, a number, a switch. */
export type SettingValueType = "text" | "url" | "number" | "boolean";

/**
 * An app's plain setting as `settings` (or a feature's) lists it: a value
 * that isn't a secret (a PostHog host, a project id, a region) and differs
 * per install, set like a secret with `everyapp configure <app>` and read
 * from `env` as a string.
 */
export interface SettingEntry extends OwnValueFields {
  name: string;
  why?: string;
  docs?: string;
  /** What it takes; `text` when not given. */
  type?: SettingValueType;
  /** The values it may take, for a `text` setting that is one of a list. */
  values?: readonly string[];
  /** What the deploy sets it to while nobody has set it. */
  default?: string;
}

/** One feature as the manifest declares it (`features.<id>`). */
export interface FeatureEntry {
  id: string;
  /** What people read: "GitHub". */
  name: string;
  /** Required features keep the app closed until set; optional ones (the default) are all or nothing. */
  required: boolean;
  why?: string;
  /** Short Markdown lines, in order; may hold `{appUrl}` and `{gatewayUrl}`. */
  steps: string[];
  /** The Gateway capabilities and providers it needs, by id (declared under `capabilities` and `providers` too). */
  capabilities: string[];
  providers: string[];
}

/** What a plain setting's value must be: what `configure` checks and every surface says. */
export interface SettingValueRule {
  type: SettingValueType;
  values?: string[];
  default?: string;
}

/** What any declaration may say about why it is needed. */
export interface SettingNeedFields {
  /** Why the app needs it, for whoever sets it (200 characters at most). */
  why?: string;
  /** Where the key or client comes from: an https URL. */
  docs?: string;
}

/** The manifest fields this module reads, as a stored or authored manifest has them. */
export interface SettingsManifestLike {
  readonly providers?: ReadonlyArray<string | ProviderEntry>;
  readonly capabilities?: { readonly [id: string]: unknown };
  readonly secrets?: ReadonlyArray<string | SecretEntry>;
  readonly settings?: ReadonlyArray<SettingEntry>;
  /** Feature id → its name, need, steps and values (`features` in everyapp.config.ts). */
  readonly features?: { readonly [id: string]: unknown };
  readonly ai?: {
    /** The app needs the Gateway's default chat model (`/api/ai/default`): `true`, or an entry with its need. */
    readonly chat?: boolean | SettingNeedFields;
  };
  /**
   * A remote MCP app's registration (./remoteMcp.ts). Its credential is
   * the provider it lists under `capabilities`; a block that can't be read
   * (one from before provider credentials) is a `remote-mcp` setting that
   * is never set: remove the app and add it again.
   */
  readonly remote?: unknown;
  readonly name?: string;
}

export type SettingKind =
  | "provider"
  | "capability"
  | "secret"
  /** An app's plain setting (`settings`): a value on its Worker, not a key. */
  | "setting"
  /** The Gateway's default model provider (`ai.chat`): one key of any provider in the order, or the operator's choice. */
  | "ai-default"
  /**
   * A remote MCP app's registration that can't be read (./remoteMcp.ts:
   * one from before provider credentials): no names, never set, fixed by
   * removing the app and adding it again. A readable registration's
   * credential is the provider under `capabilities`, a `capability`.
   */
  | "remote-mcp";

/** Which Worker holds a setting: the Gateway's, or the app's own. */
export type SettingHolder = "gateway" | "app";

export type SettingNeed = { kind: "required" } | { kind: "optional" };

/** What `appSettings` may be told about the Gateway, for the default model provider. */
export interface AppSettingsOptions {
  /** What is set, to put the configured provider first; absent, the order decides. */
  isSet?: IsSet;
}

/** One thing the app needs set, as the manifest declares it. */
export interface AppSetting {
  kind: SettingKind;
  /** The provider id, capability id or secret name. */
  id: string;
  /** "OpenRouter", "DataForSEO", "MAIN_SECRET". */
  label: string;
  holder: SettingHolder;
  /** Every one of these must be set for the setting to count as set (or any one group of `alternatives`). */
  names: string[];
  /**
   * For the default model provider: the settings of each provider that
   * could serve it, any one group of which, all set, makes the setting
   * set; `names` is the first group, what to ask for.
   */
  alternatives?: string[][];
  /** Read when set, never required (a capability's optional settings). */
  alsoReads: string[];
  need: SettingNeed;
  why?: string;
  docs?: string;
  /**
   * What an agent reads to set a Gateway setting up end to end: the
   * registry's setup guide, relative to the agent docs (`setup/dataforseo.md`
   * is https://everyapp.com/docs/agent/setup/dataforseo.md; in the checkout
   * `landing-page/content/agent/setup/…`). An app's own value has its
   * feature's steps and its `how` instead.
   */
  setup?: string;
  /** The feature it belongs to (a `features` key); absent for a top-level declaration. */
  feature?: string;
  /** For an app's own value: where it lives and what permission it needs, placeholders unfilled. */
  how?: string;
  /** An app's own secret `configure` makes when unset. */
  generate?: boolean;
  /** An app's own secret whose value is a file's contents. */
  file?: boolean;
  /**
   * What the key is and where it comes from, in a sentence or three, from
   * the provider's entry (its `hint`, and each secret's own after it):
   * what the "Needs setup" dialog, `everyapp status` and `everyapp
   * configure` show beside `why`. A provider registered on the gateway
   * has no guide, so this is what an agent reads for it.
   */
  hint?: string;
  /**
   * For an app's plain setting (`kind: "setting"`): what its value must
   * be, and its default. A setting without one is a credential, never
   * shown.
   */
  value?: SettingValueRule;
}

/** A setting with whether it is set, and whether that keeps the app closed. */
export interface EvaluatedSetting extends AppSetting {
  /**
   * True: every name is set. False: one isn't. Null: not known (an app
   * Worker whose secret names were never recorded), which never blocks.
   */
  set: boolean | null;
  /** This setting keeps the app from opening: required and unset. */
  blocking: boolean;
}

/**
 * A feature's state: `off` while none of its own values is set (an
 * optional feature that's off never blocks), `incomplete` while some are
 * and others aren't (a warning, never a block, for an optional one),
 * `ready` once every value and every Gateway setting it needs is set.
 */
export type FeatureState = "off" | "incomplete" | "ready";

/** A feature with its settings evaluated. */
export interface FeatureReport extends FeatureEntry {
  state: FeatureState;
  /** Its own values and the Gateway settings it needs, in manifest order. */
  settings: EvaluatedSetting[];
}

/** What `evaluateAppSettings` finds: whether the app opens, and every setting's state. */
export interface AppSettingsReport {
  /** No required setting is unset. */
  ready: boolean;
  /** Every setting, in manifest order: providers, capabilities, secrets, settings. */
  settings: EvaluatedSetting[];
  /** The settings that keep the app closed, in manifest order. */
  unmet: EvaluatedSetting[];
  /** Every feature, in manifest order. */
  features: FeatureReport[];
}

function needFields(entry: unknown): SettingNeedFields {
  if (!entry || typeof entry !== "object") return {};
  const record = entry as Record<string, unknown>;
  return {
    ...(typeof record["why"] === "string" ? { why: record["why"] } : {}),
    ...(typeof record["docs"] === "string" ? { docs: record["docs"] } : {}),
  };
}

/** `how`, `generate` and `file` as a stored entry has them. */
function ownValueFields(
  entry: unknown,
): Pick<SecretEntry, "how" | "generate" | "file"> {
  if (!entry || typeof entry !== "object") return {};
  const record = entry as Record<string, unknown>;
  return {
    ...(typeof record["how"] === "string" ? { how: record["how"] } : {}),
    ...(record["generate"] === true ? { generate: true } : {}),
    ...(record["file"] === true ? { file: true } : {}),
  };
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((each): each is string => typeof each === "string")
    : [];

/** The features the manifest declares, in order, each read whatever a stored row holds. */
export function featureEntries(
  manifest: Pick<SettingsManifestLike, "features">,
): FeatureEntry[] {
  const features = manifest.features;
  if (!features || typeof features !== "object") return [];
  return Object.entries(features).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const record = raw as Record<string, unknown>;
    return [
      {
        id,
        name:
          typeof record["name"] === "string" && record["name"].trim()
            ? record["name"]
            : id,
        required: record["required"] === true,
        ...(typeof record["why"] === "string" ? { why: record["why"] } : {}),
        steps: stringList(record["steps"]),
        capabilities: stringList(record["capabilities"]),
        providers: stringList(record["providers"]),
      },
    ];
  });
}

/** One feature's raw `secrets` or `settings` list, with the feature id. */
function featureLists(
  manifest: Pick<SettingsManifestLike, "features">,
  key: "secrets" | "settings",
): Array<{ feature: string; list: readonly unknown[] }> {
  const features = manifest.features;
  if (!features || typeof features !== "object") return [];
  return Object.entries(features).flatMap(([feature, raw]) => {
    const list =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)[key]
        : undefined;
    return Array.isArray(list) ? [{ feature, list }] : [];
  });
}

/** The need of a capability or provider: optional when an optional feature lists it, else required. */
function gatewayNeedOf(
  features: readonly FeatureEntry[],
  kind: "capabilities" | "providers",
  id: string,
): { need: SettingNeed; feature?: string } {
  const owner = features.find((feature) => feature[kind].includes(id));
  if (!owner) return { need: { kind: "required" } };
  return {
    need: { kind: owner.required ? "required" : "optional" },
    feature: owner.id,
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

function secretEntryOf(entry: unknown, feature?: string): SecretEntry[] {
  const tag = feature === undefined ? {} : { feature };
  if (typeof entry === "string") return [{ name: entry, ...tag }];
  if (entry && typeof entry === "object") {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") {
      return [{ name, ...needFields(entry), ...ownValueFields(entry), ...tag }];
    }
  }
  return [];
}

/**
 * The app's own secrets the manifest lists, each as an entry whatever form
 * it took: the top-level ones, then each feature's (tagged with it).
 */
export function secretEntries(
  manifest: Pick<SettingsManifestLike, "secrets" | "features">,
): SecretEntry[] {
  return [
    ...(manifest.secrets ?? []).flatMap((entry) => secretEntryOf(entry)),
    ...featureLists(manifest, "secrets").flatMap(({ feature, list }) =>
      list.flatMap((entry) => secretEntryOf(entry, feature)),
    ),
  ];
}

/** The names of the app's own secrets, in order. */
export function secretNames(
  manifest: Pick<SettingsManifestLike, "secrets" | "features">,
): string[] {
  return secretEntries(manifest).map((entry) => entry.name);
}

function settingEntryOf(entry: unknown, feature?: string): SettingEntry[] {
  if (!entry || typeof entry !== "object") return [];
  const record = entry as Record<string, unknown>;
  if (typeof record["name"] !== "string") return [];
  const type = record["type"];
  const values = record["values"];
  return [
    {
      name: record["name"],
      ...needFields(entry),
      ...(typeof record["how"] === "string" ? { how: record["how"] } : {}),
      ...(type === "url" ||
      type === "number" ||
      type === "boolean" ||
      type === "text"
        ? { type }
        : {}),
      ...(Array.isArray(values) &&
      values.every((value) => typeof value === "string")
        ? { values: values as string[] }
        : {}),
      ...(typeof record["default"] === "string"
        ? { default: record["default"] }
        : {}),
      ...(feature === undefined ? {} : { feature }),
    },
  ];
}

/** The app's plain settings the manifest lists, each as an entry: the top-level ones, then each feature's. */
export function settingEntries(
  manifest: Pick<SettingsManifestLike, "settings" | "features">,
): SettingEntry[] {
  return [
    ...(manifest.settings ?? []).flatMap((entry) => settingEntryOf(entry)),
    ...featureLists(manifest, "settings").flatMap(({ feature, list }) =>
      list.flatMap((entry) => settingEntryOf(entry, feature)),
    ),
  ];
}

/** The names of the app's plain settings, in order. */
export function settingNames(
  manifest: Pick<SettingsManifestLike, "settings" | "features">,
): string[] {
  return settingEntries(manifest).map((entry) => entry.name);
}

/**
 * Every name the manifest puts on the app's own Workers: its secrets,
 * then its plain settings. What `secret set` routes to the app and what
 * `apps.secret_names` records.
 */
export function appWorkerNames(
  manifest: Pick<SettingsManifestLike, "secrets" | "settings" | "features">,
): string[] {
  return [...secretNames(manifest), ...settingNames(manifest)];
}

/** A plain setting's rule, from its entry. */
export function settingValueRule(entry: SettingEntry): SettingValueRule {
  return {
    type: entry.type ?? "text",
    ...(entry.values?.length ? { values: [...entry.values] } : {}),
    ...(entry.default !== undefined ? { default: entry.default } : {}),
  };
}

/** `a, b or c`. */
function either(values: readonly string[]): string {
  return values.length < 2
    ? (values[0] ?? "")
    : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

/**
 * What a plain setting takes, completing "Takes …": "an http or https
 * URL", "one of us or eu", with ", default <value>" when it has one.
 */
export function settingValueTakes(rule: SettingValueRule): string {
  const what = rule.values?.length
    ? `${rule.values.length > 2 ? "one of " : ""}${either(rule.values)}`
    : {
        text: "any text",
        url: "an http or https URL",
        number: "a number",
        boolean: "true or false",
      }[rule.type];
  return rule.default !== undefined ? `${what}, default ${rule.default}` : what;
}

/**
 * Why `value` won't do for a plain setting (one sentence), or null when
 * it will: never empty, and of its type, or one of its values exactly.
 */
export function settingValueProblem(
  rule: Pick<SettingValueRule, "type" | "values">,
  value: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a value.";
  if (rule.values?.length) {
    return rule.values.includes(trimmed)
      ? null
      : `Not ${rule.values.length > 2 ? "one of " : ""}${either(rule.values)}.`;
  }
  switch (rule.type) {
    case "text":
      return null;
    case "url": {
      let url: URL | null = null;
      try {
        url = new URL(trimmed);
      } catch {
        url = null;
      }
      return url && (url.protocol === "http:" || url.protocol === "https:")
        ? null
        : `"${trimmed}" isn't an http or https URL.`;
    }
    case "number":
      return /^-?\d+(\.\d+)?$/.test(trimmed)
        ? null
        : `"${trimmed}" isn't a number.`;
    case "boolean":
      return trimmed === "true" || trimmed === "false"
        ? null
        : "Not true or false.";
  }
}

/**
 * The Gateway settings an AI provider needs, the install's left out (set
 * already). A catalog provider's names are settable by definition; a
 * registered row's are its own, so they count too.
 */
function providerNames(capability: AiProviderCapability): string[] {
  // An optional key (AI Gateway's own token) is never a need.
  return aiRequiredSettings(capability).filter(
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
    case "oauth_client":
      return {
        names: [
          capability.secrets.clientId,
          ...(capability.secrets.clientSecret
            ? [capability.secrets.clientSecret]
            : []),
        ],
        alsoReads: [],
      };
  }
}

/**
 * Where a capability's key or client comes from, when the registry knows:
 * an API-key provider's access page, or an OAuth client's console.
 */
function capabilityDocs(capability: Capability): string | undefined {
  switch (capability.mode) {
    case "api_key":
    case "ai":
      return capability.docs;
    case "oauth_client":
      return capability.console;
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
  need: { need: SettingNeed; feature?: string },
  defaults: { docs?: string; setup?: string; hint?: string } = {},
): AppSetting {
  const docs = entry?.docs ?? defaults.docs;
  return {
    ...setting,
    need: need.need,
    ...(need.feature === undefined ? {} : { feature: need.feature }),
    ...(entry?.why ? { why: entry.why } : {}),
    ...(docs ? { docs } : {}),
    ...(defaults.setup ? { setup: defaults.setup } : {}),
    ...(defaults.hint ? { hint: defaults.hint } : {}),
  };
}

/**
 * A stored manifest from before features (deployed before 0.3.0-rc.14) marks a
 * value `optional: true`. The strict schema refuses that key now, but a stored
 * row keeps it until the app is redeployed, so it still reads as optional:
 * updating the Gateway never puts a working app into Needs setup.
 */
function storedOptional(
  need: { need: SettingNeed; feature?: string },
  raw: unknown,
): { need: SettingNeed; feature?: string } {
  if (need.feature !== undefined || need.need.kind === "optional") return need;
  const optional =
    raw !== null &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>)["optional"] === true;
  return optional ? { need: { kind: "optional" } } : need;
}

/** The raw entry named `name` in a stored list (`secrets`, `settings`, `providers`). */
function rawEntry(list: unknown, name: string, key: "name" | "id"): unknown {
  if (!Array.isArray(list)) return undefined;
  return list.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>)[key] === name,
  );
}

/** An app's own value's need: its feature's (required, or optional), or required at the top level. */
function ownNeedOf(
  features: readonly FeatureEntry[],
  feature: string | undefined,
): { need: SettingNeed; feature?: string } {
  if (feature === undefined) return { need: { kind: "required" } };
  const owner = features.find((each) => each.id === feature);
  return {
    need: { kind: owner?.required ? "required" : "optional" },
    feature,
  };
}

/** `how`, `generate` and `file` onto an app's own setting, when its entry says them. */
function withOwnValue(
  setting: AppSetting,
  entry: Pick<SecretEntry, "how" | "generate" | "file">,
): AppSetting {
  return {
    ...setting,
    ...(entry.how ? { how: entry.how } : {}),
    ...(entry.generate ? { generate: true } : {}),
    ...(entry.file ? { file: true } : {}),
  };
}

/**
 * Every setting the manifest declares, in manifest order: its AI
 * providers, its capabilities, then the app's own secrets. A provider or capability the
 * gateway doesn't offer contributes nothing (the manifest validator refuses
 * it elsewhere); so does a capability with nothing to set (`members`),
 * which is always set. `lookup` is where ids are found: the catalog alone
 * by default, or a gateway's registry with its registered rows.
 */
export function appSettings(
  manifest: SettingsManifestLike,
  lookup: CapabilityLookup = CATALOG,
  options: AppSettingsOptions = {},
): AppSetting[] {
  const settings: AppSetting[] = [];
  const features = featureEntries(manifest);
  const chat = manifest.ai?.chat;
  if (chat === true || (chat && typeof chat === "object")) {
    // The default resolves on what is set: with nothing set, the first of
    // the order (or the operator's choice) and its settings are what to
    // ask for; with one configured, that provider's. `isSet` here only
    // orders the candidates; evaluateAppSettings decides what is set.
    const resolution = resolveAiDefault({
      choice: null,
      isSet: options.isSet ?? (() => false),
      lookup,
    });
    const settable = (names: readonly string[]) =>
      names.filter((name) => !isInstallOwnedGatewaySetting(name));
    const provider = lookup.get(resolution.provider);
    settings.push(
      withNeed(
        {
          kind: "ai-default",
          id: "ai-default",
          label: `A chat model (${resolution.label})`,
          holder: "gateway",
          names: settable(resolution.settings),
          alsoReads: [],
          alternatives: resolution.candidates
            .map((candidate) => settable(candidate.settings))
            .filter((names) => names.length > 0),
        },
        chat === true ? undefined : needFields(chat),
        storedOptional({ need: { kind: "required" } }, chat),
        {
          ...(provider?.mode === "ai" ? { docs: provider.docs } : {}),
          setup: "setup/ai.md",
          hint: aiDefaultSetupHint(resolution),
        },
      ),
    );
  }
  // The default's settings: an optional pin (a provider an optional
  // feature lists) that needs only those is the same row (one key, set
  // once), so it isn't listed twice. A required pin stays: it needs that
  // provider's key even while another provider serves the default.
  const defaultNames = settings.find(
    (setting) => setting.kind === "ai-default",
  )?.names;
  for (const entry of providerEntries(manifest)) {
    const capability = lookup.get(entry.id);
    if (capability?.mode !== "ai") continue;
    const names = providerNames(capability);
    const need = storedOptional(
      gatewayNeedOf(features, "providers", entry.id),
      rawEntry(manifest.providers, entry.id, "id"),
    );
    if (
      defaultNames &&
      need.need.kind === "optional" &&
      names.length > 0 &&
      names.every((name) => defaultNames.includes(name))
    ) {
      continue;
    }
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
        need,
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
        storedOptional(gatewayNeedOf(features, "capabilities", id), entry),
        {
          docs: capabilityDocs(capability),
          setup:
            capability.mode === "oauth_client"
              ? oauthSetupGuide(id)
              : capability.setup,
          ...providerHint(capability, names),
        },
      ),
    );
  }
  const remoteProblem = hasRemoteMcpBlock(manifest)
    ? remoteMcpBlockProblem(manifest)
    : null;
  if (remoteProblem) {
    const label =
      typeof manifest.name === "string" && manifest.name.trim()
        ? manifest.name.trim()
        : "the MCP server";
    settings.push({
      kind: "remote-mcp",
      id: "remote",
      label: `${label} registration`,
      holder: "gateway",
      names: [],
      alsoReads: [],
      need: { kind: "required" },
      why: `${label}'s registration can't be read: ${remoteProblem}.`,
      setup: "setup/remote-mcp.md",
    });
  }
  for (const entry of secretEntries(manifest)) {
    settings.push(
      withOwnValue(
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
          storedOptional(
            ownNeedOf(features, entry.feature),
            rawEntry(manifest.secrets, entry.name, "name"),
          ),
        ),
        entry,
      ),
    );
  }
  for (const entry of settingEntries(manifest)) {
    const own = storedOptional(
      ownNeedOf(features, entry.feature),
      rawEntry(manifest.settings, entry.name, "name"),
    );
    settings.push({
      ...withOwnValue(
        withNeed(
          {
            kind: "setting",
            id: entry.name,
            label: entry.name,
            holder: "app",
            names: [entry.name],
            alsoReads: [],
          },
          entry,
          // A setting with a default is never unset for long: the deploy writes it.
          entry.default !== undefined
            ? { ...own, need: { kind: "optional" } }
            : own,
        ),
        entry,
      ),
      value: settingValueRule(entry),
    });
  }
  return settings;
}

/** Whether each name of `setting` is set: all → true, one unset → false, else unknown. */
function settingIsSet(
  setting: AppSetting,
  isSet: (holder: SettingHolder, name: string) => boolean | null,
): boolean | null {
  // An unreadable remote registration has nothing to set: it is fixed by
  // adding the app again, never by a value.
  if (setting.kind === "remote-mcp") return false;
  const groupIsSet = (names: readonly string[]): boolean | null => {
    let unknown = false;
    for (const name of names) {
      const state = isSet(setting.holder, name);
      if (state === false) return false;
      if (state === null) unknown = true;
    }
    return unknown ? null : true;
  };
  if (!setting.alternatives?.length) return groupIsSet(setting.names);
  // Any one provider configured makes the default serve; unknown only
  // when no group is set and one couldn't be read.
  let unknown = false;
  for (const names of setting.alternatives) {
    const state = groupIsSet(names);
    if (state === true) return true;
    if (state === null) unknown = true;
  }
  return unknown ? null : false;
}

export interface EvaluateOptions {
  /**
   * A capability's own readiness rule, where names alone don't say (the
   * gateway's email is configured once a sender parses and a provider is
   * selectable): a boolean or null overrides the names; undefined defers
   * to them.
   */
  readiness?: (setting: AppSetting) => boolean | null | undefined;
  /** The manifest's features ({@link featureEntries}), for their states; none by default. */
  features?: readonly FeatureEntry[];
}

/**
 * A feature's state from its settings (see {@link FeatureState}). Whether
 * it is started is read from its own values that have no default (a
 * default is written by the deploy, so it says nothing), or, for a
 * feature of Gateway settings alone, from those.
 */
function featureState(settings: readonly EvaluatedSetting[]): FeatureState {
  if (settings.every((setting) => setting.set !== false)) return "ready";
  const own = settings.filter(
    (setting) =>
      setting.holder === "app" && setting.value?.default === undefined,
  );
  const started = (own.length > 0 ? own : settings).some(
    (setting) => setting.set === true,
  );
  return started ? "incomplete" : "off";
}

/**
 * Every setting against what is set. `isSet` answers per holder and name:
 * true, false, or null when it can't tell (the registry never recorded
 * the app Worker's secret names), which never blocks. A required setting
 * that is unset blocks; an optional one (an optional feature's) never does.
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
  for (const setting of evaluated) {
    if (setting.need.kind === "required" && setting.set === false) {
      setting.blocking = true;
    }
  }
  const unmet = evaluated.filter((setting) => setting.blocking);
  const features = (options.features ?? []).map((feature) => {
    const own = evaluated.filter((setting) => setting.feature === feature.id);
    return { ...feature, settings: own, state: featureState(own) };
  });
  return { ready: unmet.length === 0, settings: evaluated, unmet, features };
}

/** The one command that opens the app. */
export interface SetupCommand {
  /**
   * `everyapp configure <app>`: asks for every required setting the app
   * lacks, feature by feature, then offers its optional features, and sets
   * each where it is held.
   */
  command: string;
}

/**
 * What to run for an app that needs setup: `everyapp configure <app>`,
 * which reads the app's manifest (from the registry, so it runs from
 * anywhere), prompts for each unmet setting, feature by feature, and sets
 * them where they are held. Null when
 * the app is ready. `cli` is how the operator runs everyapp (`pnpm
 * everyapp` from a checkout). Scripts that set one name at a time use
 * `everyapp secret set NAME [--app <id>]` instead.
 *
 * A provider app (`provider`: the gateway's own, with no Worker and no
 * directory; `everyapp mcp on <id>`, an MCP app) has nothing to configure: its
 * command is the `secret set` of its Gateway key, as `mcp list` says it.
 */
export function setupCommand(
  report: Pick<AppSettingsReport, "unmet">,
  {
    cli,
    appId,
    provider = false,
  }: { cli: string; appId: string; provider?: boolean },
): SetupCommand | null {
  if (report.unmet.length === 0) return null;
  if (report.unmet.some((setting) => setting.kind === "remote-mcp")) {
    // Nothing to set: the registration predates provider credentials.
    return { command: `${cli} mcp remove ${appId}` };
  }
  if (!provider) return { command: `${cli} configure ${appId}` };
  const names: string[] = [];
  const add = (setting: EvaluatedSetting) => {
    for (const name of setting.names)
      if (!names.includes(name)) names.push(name);
  };
  for (const setting of report.unmet) add(setting);
  return { command: `${cli} secret set ${names.join(" ")}` };
}

/** One setting as `AppSetup` carries it: the evaluation without what only the CLI reads. */
export type AppSetupSetting = Omit<EvaluatedSetting, "alsoReads">;

/**
 * An app's setup state as every surface shows it, the same on the
 * gateway's app lists (`setup`), `everyapp status --json`
 * (`apps[].setup`) and `everyapp secret list --json`: whether it opens,
 * every setting with its state, every feature with its state, and the
 * one command that opens it, `everyapp configure <app>` (null when it is
 * ready, or when whoever reads this can't run it: a shared app seen from
 * another organization).
 */
export interface AppSetup {
  ready: boolean;
  settings: AppSetupSetting[];
  unmet: AppSetupSetting[];
  /** Each feature: its name, need, steps (placeholders unfilled), state, and its settings' ids. */
  features: AppSetupFeature[];
  command: SetupCommand | null;
}

/** One feature as `AppSetup` carries it. */
export interface AppSetupFeature extends FeatureEntry {
  state: FeatureState;
  /** The ids of its settings (in `settings`), in manifest order. */
  settings: string[];
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
    features: report.features.map((feature) => ({
      ...feature,
      settings: feature.settings.map((setting) => setting.id),
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

/**
 * A fresh value for a secret the manifest marks `generate: true`: 32
 * bytes from the platform's cryptographic random source, base64url
 * without padding (43 characters).
 */
export function generatedSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
