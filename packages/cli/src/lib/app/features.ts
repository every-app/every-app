/**
 * An app's features (`features` in everyapp.config.ts) as `everyapp
 * configure` shows them: the numbered steps with `{appUrl}` and
 * `{gatewayUrl}` filled in and Markdown links as plain text, each Gateway
 * setting a feature needs with the one command that sets it, and the
 * `--json` shape an agent reads to set a feature up end to end. Also what
 * a `file: true` value and a `generate: true` one become.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  CapabilityLookup,
  EvaluatedSetting,
  FeatureReport,
  FeatureState,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import { CLI } from "@/lib/output/command";
import { plainText } from "@/lib/providerDocs";

/** The real URLs a feature's text names: the app's and the Gateway's. */
export interface SetupUrls {
  appUrl: string;
  gatewayUrl: string;
}

/** `text` with `{appUrl}` and `{gatewayUrl}` filled in. */
export function fillPlaceholders(text: string, urls: SetupUrls): string {
  return text.replace(/\{(appUrl|gatewayUrl)\}/g, (_match, name: keyof SetupUrls) => urls[name]);
}

/**
 * The command that sets a Gateway setting a feature needs: `provider add`
 * for a key or an OAuth client, and for a Gateway service (email) or
 * anything else, its names by `secret set`.
 */
function gatewaySettingCommand(
  setting: Pick<EvaluatedSetting, "id" | "kind" | "names">,
  lookup: CapabilityLookup,
): string {
  const mode = setting.kind === "provider" || setting.kind === "capability" ? lookup.get(setting.id)?.mode : undefined;
  if (mode === "api_key" || mode === "ai" || mode === "oauth_client") return `${CLI} provider add ${setting.id}`;
  return `${CLI} secret set ${setting.names.join(" ")}`;
}

/**
 * What configure prints before a feature's prompts: its name, why, the
 * numbered steps, then each Gateway setting it needs, set or with the one
 * command that sets it (configure never asks for those inside a feature).
 */
export function featureIntro(feature: FeatureReport, urls: SetupUrls, lookup: CapabilityLookup): string[] {
  const gateway = feature.settings.filter((setting) => setting.holder === "gateway");
  return [
    "",
    chalk.bold(feature.name),
    ...(feature.why ? [chalk.dim(feature.why)] : []),
    ...feature.steps.map((step, index) => `${index + 1}. ${plainText(fillPlaceholders(step, urls))}`),
    ...gateway.map((setting) =>
      setting.set === false
        ? `${chalk.yellow("!")} ${setting.label} isn't set on the Gateway: ${gatewaySettingCommand(setting, lookup)}`
        : `${chalk.green("✓")} ${setting.label} is set on the Gateway`,
    ),
  ];
}

/** One value of a feature, as `configure --json` gives it. */
interface FeatureValueData {
  name: string;
  kind: "secret" | "setting";
  how?: string;
  set: boolean | null;
  generate: boolean;
  file: boolean;
}

/** One Gateway setting a feature needs, as `configure --json` gives it. */
interface FeatureNeedData {
  kind: string;
  id: string;
  label: string;
  set: boolean | null;
  /** What sets it, when it isn't set. */
  command?: string;
}

/** One feature, as `configure --json` gives it (`data.features[]`). */
export interface FeatureData {
  id: string;
  name: string;
  required: boolean;
  why?: string;
  /** The steps, Markdown, placeholders filled. */
  steps: string[];
  values: FeatureValueData[];
  needs: FeatureNeedData[];
  state: FeatureState;
}

/** Every feature with its steps filled, values and Gateway needs: what an agent sets up from. */
export function featuresData(
  features: readonly FeatureReport[],
  urls: SetupUrls,
  lookup: CapabilityLookup,
): FeatureData[] {
  return features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    required: feature.required,
    ...(feature.why ? { why: feature.why } : {}),
    steps: feature.steps.map((step) => fillPlaceholders(step, urls)),
    values: feature.settings
      .filter((setting) => setting.holder === "app")
      .map((setting) => ({
        name: setting.id,
        kind: setting.kind === "setting" ? ("setting" as const) : ("secret" as const),
        ...(setting.how ? { how: fillPlaceholders(setting.how, urls) } : {}),
        set: setting.set,
        generate: setting.generate === true,
        file: setting.file === true,
      })),
    needs: feature.settings
      .filter((setting) => setting.holder === "gateway")
      .map((setting) => ({
        kind: setting.kind,
        id: setting.id,
        label: setting.label,
        set: setting.set,
        ...(setting.set === false ? { command: gatewaySettingCommand(setting, lookup) } : {}),
      })),
    state: feature.state,
  }));
}

/**
 * A `file: true` value: the contents of the file `value` names (a path,
 * `~/` for the home directory), exactly as they are, when one is there;
 * otherwise `value` itself (the contents, pasted or piped). Only the path
 * given is read, and only a regular file.
 */
export function fileValue(value: string): string {
  const path = value.trim();
  if (!path || path.includes("\n") || path.startsWith("-----BEGIN")) return value;
  const full = path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
  if (!existsSync(full) || !statSync(full).isFile()) return value;
  return readFileSync(full, "utf8");
}
