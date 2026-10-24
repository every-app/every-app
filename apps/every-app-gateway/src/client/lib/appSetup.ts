/**
 * What the setup dialog says about an app that needs setup, from the
 * `setup` its list row carries (the SDK's AppSetup): the unmet settings
 * with why each is needed and where its key comes from, the one command
 * that sets them (or who to ask), and what else could be set. Pure, so
 * the dialog's wording is tested without rendering it.
 */
import type { AppSetup, AppSetupSetting } from "@every-app/sdk/internal";

/** How an operator re-reads the app Worker's secrets after setting one another way. */
export const STATUS_COMMAND = "pnpm everyapp status";

interface SetupDocsLink {
  href: string;
  /** The URL without its scheme, for the link's text. */
  label: string;
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
  docs: SetupDocsLink | null;
}

interface SetupDialogCommand {
  /** "Ask an admin to run:" for a reader who can't run it; null for one who can. */
  heading: string | null;
  command: string;
  /** The alternatives of an unmet any-of group. */
  note: string | null;
}

interface SetupDialogModel {
  title: string;
  /** What the reader does about it: sets it, or waits for an admin to. */
  intro: string;
  /** The settings that keep the app closed, in manifest order. */
  unmet: SetupDialogRow[];
  /** One line per unmet any-of group: "One of these is enough: A, B". */
  anyOf: string[];
  /** Null when nobody reading this can run it: a shared app of another organization. */
  command: SetupDialogCommand | null;
  /** Shown in the command's place when there is none. */
  platformNote: string | null;
  /** Unset settings the app works without, for whoever can set them. */
  optional: SetupDialogRow[];
  /**
   * Whether to say that `everyapp status` re-reads the app Worker's
   * secrets: only when a setting that keeps the app closed is the app's
   * own (the Gateway's are read live) and the reader can run it.
   */
  statusHint: boolean;
}

export const PLATFORM_NOTE = "Every App is still setting this up.";
const ASK_AN_ADMIN = "Ask an admin to run:";
const INTRO_CAN_RUN = "Set these before anyone can open it.";
// The command's heading says who; the intro doesn't say "admin" twice.
const INTRO_ASK = "It opens once these are set.";

function docsLink(docs: string | undefined): SetupDocsLink | null {
  if (!docs) return null;
  return {
    href: docs,
    label: docs.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  };
}

function row(setting: AppSetupSetting): SetupDialogRow {
  return {
    id: setting.id,
    label: setting.label,
    names: setting.names.filter((name) => name !== setting.label),
    why: setting.why ?? null,
    docs: docsLink(setting.docs),
  };
}

/**
 * `canRun`: whoever reads the dialog can run the command (an owner or
 * admin of the app's organization); a member is told to ask one. The
 * optional settings are listed only for someone who could set them.
 */
export function setupDialogModel(
  setup: AppSetup,
  { name, canRun }: { name: string; canRun: boolean },
): SetupDialogModel {
  const labelOf = (id: string) =>
    setup.settings.find((setting) => setting.id === id)?.label ?? id;
  const unmetIds = new Set(setup.unmet.map((setting) => setting.id));
  const anyOf = setup.groups
    .filter(
      (group) => !group.met && group.members.some((id) => unmetIds.has(id)),
    )
    .map(
      (group) =>
        `One of these is enough: ${group.members.map(labelOf).join(", ")}`,
    );
  const metGroups = new Set(
    setup.groups.filter((group) => group.met).map((group) => group.group),
  );
  // Unset and not blocking: declared optional, or a member of a group
  // another member already satisfies.
  const optional = canRun
    ? setup.settings.filter(
        (setting) =>
          setting.set === false &&
          !setting.blocking &&
          (setting.need.kind === "optional" ||
            (setting.need.kind === "anyOf" &&
              metGroups.has(setting.need.group))),
      )
    : [];
  return {
    title: `${name} needs setup`,
    intro: canRun ? INTRO_CAN_RUN : INTRO_ASK,
    unmet: setup.unmet.map(row),
    anyOf,
    command: setup.command
      ? {
          heading: canRun ? null : ASK_AN_ADMIN,
          command: setup.command.command,
          note: setup.command.note ?? null,
        }
      : null,
    platformNote: setup.command ? null : PLATFORM_NOTE,
    optional: optional.map(row),
    statusHint:
      canRun && setup.unmet.some((setting) => setting.holder === "app"),
  };
}
