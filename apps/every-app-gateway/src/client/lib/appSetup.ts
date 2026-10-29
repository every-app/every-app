/**
 * What the setup dialog says about an app that needs setup, from the
 * `setup` its list row carries (the SDK's AppSetup): what the app can't
 * open without, each ticked off once it is set, with why it is needed and
 * where it comes from; the one command that asks for them, `everyapp
 * configure <app>`, or who runs it; and what else could be set. Pure, so
 * the dialog's wording is tested without rendering it.
 */
import {
  settingValueTakes,
  type AppSetup,
  type AppSetupSetting,
} from "@every-app/sdk/internal";

/** How an operator re-reads the app Worker's secrets after setting one another way. */
export const STATUS_COMMAND = "pnpm everyapp status";

export const PLATFORM_NOTE = "EveryApp is still setting this up.";

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
  /** Already set. The dialog follows the live list, so rows tick off as the command sets them. */
  done: boolean;
}

interface SetupDialogModel {
  action: SetupDialogAction;
  title: string;
  /** The first step's heading, "Get 2 keys": what is still unset, one per any-of group. */
  gather: string;
  /** Everything the app can't open without, in manifest order: what is unset, and what already is (done). */
  needed: SetupDialogRow[];
  /** One line per unmet any-of group: "One of these is enough: A, B". */
  anyOf: string[];
  /** Unset settings the app works without, for whoever can set them. */
  optional: SetupDialogRow[];
  /** The folded optional section's line: "Google, Microsoft 365, Slack, +4 more". */
  optionalSummary: string;
  /**
   * Whether to say that `everyapp status` re-reads the app Worker's
   * secrets: only when a setting that keeps the app closed is the app's
   * own (the Gateway's are read live) and the reader runs the command.
   */
  statusHint: boolean;
}

/** How many optional settings the folded section names before "+N more". */
const SUMMARY_NAMES = 3;

function docsLink(docs: string | undefined): SetupDocsLink | null {
  if (!docs) return null;
  return { href: docs, host: new URL(docs).hostname.replace(/^www\./, "") };
}

function row(setting: AppSetupSetting, links: boolean): SetupDialogRow {
  return {
    id: setting.id,
    label: setting.label,
    names: setting.names.filter((name) => name !== setting.label),
    why: setting.why ?? null,
    takes: setting.value ? settingValueTakes(setting.value) : null,
    docs: links ? docsLink(setting.docs) : null,
    done: setting.set === true,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A label without its parenthetical: "Google (Gmail, Calendar)" is "Google". */
function shortLabel(label: string): string {
  return label.replace(/ \(.*\)$/, "");
}

/**
 * `canRun`: whoever reads the dialog can run the command (an owner or
 * admin of the app's organization); a member is told to ask one. Where
 * each setting comes from, and the optional settings, are only for
 * whoever runs it.
 */
export function setupDialogModel(
  setup: AppSetup,
  { name, canRun }: { name: string; canRun: boolean },
): SetupDialogModel {
  const action: SetupDialogAction = !setup.command
    ? { kind: SetupAction.Platform }
    : canRun
      ? { kind: SetupAction.Run, command: setup.command.command }
      : { kind: SetupAction.AskAdmin, command: setup.command.command };
  const runs = action.kind === SetupAction.Run;
  const labelOf = (id: string) =>
    setup.settings.find((setting) => setting.id === id)?.label ?? id;
  const unmetIds = new Set(setup.unmet.map((setting) => setting.id));
  const unmetGroups = setup.groups.filter(
    (group) => !group.met && group.members.some((id) => unmetIds.has(id)),
  );
  const metGroups = new Set(
    setup.groups.filter((group) => group.met).map((group) => group.group),
  );
  // What keeps it closed, and what already counts toward opening it: a
  // required setting that is set, or the member of an any-of group that
  // met it. Unknown (`set: null`) neither blocks nor is ticked off.
  const needed = setup.settings.filter(
    (setting) =>
      setting.blocking ||
      (setting.set === true && setting.need.kind !== "optional"),
  );
  const toGet =
    setup.unmet.filter((setting) => setting.need.kind !== "anyOf").length +
    unmetGroups.length;
  const keys = setup.unmet.every((setting) => !setting.value);
  // Unset and not blocking: declared optional, or a member of a group
  // another member already satisfies.
  const optional = runs
    ? setup.settings.filter(
        (setting) =>
          setting.set === false &&
          !setting.blocking &&
          (setting.need.kind === "optional" ||
            (setting.need.kind === "anyOf" &&
              metGroups.has(setting.need.group))),
      )
    : [];
  const named = optional
    .slice(0, SUMMARY_NAMES)
    .map((s) => shortLabel(s.label));
  const more = optional.length - named.length;
  return {
    action,
    title: runs ? `Set up ${name}` : `${name} needs setup`,
    gather: keys
      ? `Get ${plural(toGet, "key")}`
      : `Have ${plural(toGet, "setting")} ready`,
    needed: needed.map((setting) => row(setting, runs)),
    anyOf: unmetGroups.map(
      (group) =>
        `One of these is enough: ${group.members.map(labelOf).join(", ")}`,
    ),
    optional: optional.map((setting) => row(setting, true)),
    optionalSummary: [...named, ...(more > 0 ? [`+${more} more`] : [])].join(
      ", ",
    ),
    statusHint: runs && setup.unmet.some((setting) => setting.holder === "app"),
  };
}
