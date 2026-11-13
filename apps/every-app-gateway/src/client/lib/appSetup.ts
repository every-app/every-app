/**
 * What the setup dialog says about an app that needs setup, from the
 * `setup` its list row carries (the SDK's AppSetup), grouped as `everyapp
 * configure` groups it: what the manifest lists at its top level (always
 * needed), then each feature with its state, why, numbered steps and
 * values, each ticked off once it is set; and the one command that asks
 * for them, `everyapp configure <app>`, or who runs it. Pure, so the
 * dialog's wording is tested without rendering it.
 */
import {
  settingValueTakes,
  type AppSetup,
  type AppSetupFeature,
  type AppSetupSetting,
  type FeatureState,
} from "@every-app/sdk/internal";

export const PLATFORM_NOTE = "EveryApp is still setting this up.";

/** Where an owner or admin adds a Gateway setting a feature needs: Manage workspace → Providers. */
export const PROVIDERS_PATH = "/admin/providers";

/** Who sets the app up, which decides how the dialog reads. */
export enum SetupAction {
  /** The reader, an owner or admin: get the keys, run the command, come back. */
  Run = "run",
  /** A member: an admin runs the command. */
  AskAdmin = "ask-admin",
  /** Nobody reading this: a shared app of another organization, the platform's to set. */
  Platform = "platform",
}

type SetupDialogAction =
  | { kind: SetupAction.Run; command: string }
  | { kind: SetupAction.AskAdmin; command: string }
  | { kind: SetupAction.Platform };

/** The real URLs a feature's steps and values name: `{appUrl}` and `{gatewayUrl}`. */
export interface SetupUrls {
  appUrl: string;
  gatewayUrl: string;
}

/** A run of a step's text: plain, code, or a link (http or https only). */
export type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

interface SetupDocsLink {
  href: string;
  /** The site, for the link's text; the full URL is its title. */
  host: string;
}

export interface SetupDialogRow {
  id: string;
  label: string;
  /**
   * The setting names, every one of which must be set; the label itself
   * left out, so an app's own secret (labelled by its name) reads once.
   */
  names: string[];
  why: string | null;
  /** What one of the app's plain settings takes ("an http or https URL, default …"); null for a key. */
  takes: string | null;
  /** Where it comes from, for a reader who sets it; null for anyone else. */
  docs: SetupDocsLink | null;
  /** Where an app's own value lives (its `how`), placeholders filled, for a reader who sets it; null otherwise. */
  how: InlinePart[] | null;
  /** Already set. The dialog follows the live list, so rows tick off as the command sets them. */
  done: boolean;
}

/** One feature, as the dialog shows it. */
export interface SetupDialogFeature {
  id: string;
  name: string;
  required: boolean;
  state: FeatureState;
  why: string | null;
  /** The numbered steps, placeholders filled; none for a reader who doesn't set it. */
  steps: InlinePart[][];
  /** Its own values, on the app's Worker. */
  values: SetupDialogRow[];
  /** The Gateway settings it needs (a provider, a capability): Manage workspace → Providers. */
  gateway: SetupDialogRow[];
}

interface SetupDialogModel {
  action: SetupDialogAction;
  title: string;
  /** The first step's heading, "Get 2 keys": what is still unset. */
  gather: string;
  /**
   * What the manifest lists at its top level, in manifest order: what is
   * unset, and what already is (done). The app never opens without it.
   */
  always: SetupDialogRow[];
  /** The features the app can't open without. */
  required: SetupDialogFeature[];
  /**
   * The features the app works without, for whoever can set them; an
   * optional value no feature holds (a stored manifest from before
   * features) is one more, "More settings".
   */
  optional: SetupDialogFeature[];
}

const MARKDOWN =
  /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s<>()]+)/g;

/**
 * A step's Markdown as runs of text: `[text](url)` and a bare URL as
 * links (http or https only; anything else stays text), code ticks as
 * code, `**bold**` as its text. Trailing punctuation stays outside a bare
 * URL.
 */
export function inlineParts(markdown: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.kind === "text") last.text += value;
    else parts.push({ kind: "text", text: value });
  };
  let at = 0;
  for (const match of markdown.matchAll(MARKDOWN)) {
    const [whole, label, href, code, bold, bare] = match;
    text(markdown.slice(at, match.index));
    at = match.index + whole.length;
    if (label !== undefined && href !== undefined) {
      if (/^https?:\/\//i.test(href))
        parts.push({ kind: "link", text: label, href });
      else text(label);
    } else if (code !== undefined) {
      parts.push({ kind: "code", text: code });
    } else if (bold !== undefined) {
      text(bold);
    } else if (bare !== undefined) {
      const url = bare.replace(/[.,;:!?'"]+$/, "");
      parts.push({ kind: "link", text: url, href: url });
      text(bare.slice(url.length));
    }
  }
  text(markdown.slice(at));
  return parts;
}

/** `text` with `{appUrl}` and `{gatewayUrl}` filled in. */
function fill(text: string, urls: SetupUrls): string {
  return text.replace(
    /\{(appUrl|gatewayUrl)\}/g,
    (_match, name: keyof SetupUrls) => urls[name],
  );
}

function docsLink(docs: string | undefined): SetupDocsLink | null {
  if (!docs) return null;
  return { href: docs, host: new URL(docs).hostname.replace(/^www\./, "") };
}

function row(
  setting: AppSetupSetting,
  links: boolean,
  urls: SetupUrls,
): SetupDialogRow {
  return {
    id: setting.id,
    label: setting.label,
    names: setting.names.filter((name) => name !== setting.label),
    why: setting.why ?? null,
    takes: setting.value ? settingValueTakes(setting.value) : null,
    docs: links ? docsLink(setting.docs) : null,
    how: links && setting.how ? inlineParts(fill(setting.how, urls)) : null,
    done: setting.set === true,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * `canRun`: whoever reads the dialog can run the command (an owner or
 * admin of the app's organization); a member is told to ask one. Where
 * each setting comes from, the features' steps, and the optional
 * features are only for whoever runs it.
 */
export function setupDialogModel(
  setup: AppSetup,
  { name, canRun, urls }: { name: string; canRun: boolean; urls: SetupUrls },
): SetupDialogModel {
  const action: SetupDialogAction = !setup.command
    ? { kind: SetupAction.Platform }
    : canRun
      ? { kind: SetupAction.Run, command: setup.command.command }
      : { kind: SetupAction.AskAdmin, command: setup.command.command };
  const runs = action.kind === SetupAction.Run;
  const byId = new Map(setup.settings.map((setting) => [setting.id, setting]));
  const inFeature = new Set(setup.features.flatMap((each) => each.settings));
  const topLevel = setup.settings.filter(
    (setting) => setting.feature === undefined && !inFeature.has(setting.id),
  );
  const section = (feature: AppSetupFeature): SetupDialogFeature => {
    const own = feature.settings.flatMap((id) => byId.get(id) ?? []);
    return {
      id: feature.id,
      name: feature.name,
      required: feature.required,
      state: feature.state,
      why: feature.why ?? null,
      steps: runs
        ? feature.steps.map((step) => inlineParts(fill(step, urls)))
        : [],
      values: own
        .filter((setting) => setting.holder === "app")
        .map((setting) => row(setting, runs, urls)),
      gateway: own
        .filter((setting) => setting.holder === "gateway")
        .map((setting) => row(setting, false, urls)),
    };
  };
  // A top-level value a stored manifest marks optional (from before
  // features), unset: one more optional group.
  const loose = topLevel.filter(
    (setting) => setting.set === false && setting.need.kind === "optional",
  );
  const more: SetupDialogFeature[] = loose.length
    ? [
        {
          id: "",
          name: "More settings",
          required: false,
          state: "off",
          why: null,
          steps: [],
          values: loose
            .filter((setting) => setting.holder === "app")
            .map((setting) => row(setting, true, urls)),
          gateway: loose
            .filter((setting) => setting.holder === "gateway")
            .map((setting) => row(setting, false, urls)),
        },
      ]
    : [];
  const toGet = setup.unmet.length;
  const keys = setup.unmet.every((setting) => !setting.value);
  return {
    action,
    title: runs ? `Set up ${name}` : `${name} needs setup`,
    gather: keys
      ? `Get ${plural(toGet, "key")}`
      : `Have ${plural(toGet, "setting")} ready`,
    // What keeps it closed, and what already counts toward opening it: a
    // required setting that is set. Unknown (`set: null`) neither blocks
    // nor is ticked off.
    always: topLevel
      .filter(
        (setting) =>
          setting.blocking ||
          (setting.set === true && setting.need.kind !== "optional"),
      )
      .map((setting) => row(setting, runs, urls)),
    required: setup.features.filter((each) => each.required).map(section),
    optional: runs
      ? [
          ...setup.features.filter((each) => !each.required).map(section),
          ...more,
        ]
      : [],
  };
}
