/**
 * `everyapp skills update`: the app in this directory gets the skills this
 * CLI ships, replacing the copies `create` put in `.claude/skills/<name>`
 * and `.agents/skills/<name>` (lib/app/skill.ts, the same code create
 * runs). A copy that is already the same is left as it is; directories
 * there that aren't a shipped skill are never touched.
 */
import path from "node:path";
import { syncSkills, type SkillCopyChange } from "@/lib/app/skill";
import { templateSource } from "@/lib/checkout";
import { EveryAppError } from "@/lib/errors";
import { fileExists } from "@/lib/file-operations";
import type { EventSink } from "@/lib/output/events";
import { runCommand } from "@/lib/output/run";
import { plural } from "@/lib/output/text";

interface UpdateFlags {
  json?: boolean;
}

export async function update(flags: UpdateFlags): Promise<void> {
  await runCommand(flags, (out) => updateSkills({ cwd: process.cwd(), out }));
}

export async function updateSkills({
  cwd,
  out,
  skillsDir = templateSource().skillsDir,
}: {
  cwd: string;
  out: EventSink;
  /** Where the shipped skills are (tests; lib/checkout.ts `templateSource`). */
  skillsDir?: string;
}): Promise<void> {
  if (!(await fileExists(path.join(cwd, "everyapp.config.ts")))) {
    throw new EveryAppError("MANIFEST_NOT_FOUND", "No everyapp.config.ts in this directory", {
      fix: "run this from the app's directory",
    });
  }
  const { skills, changes, agentsMd } = await syncSkills({ skillsDir, appDir: cwd });
  const changed = changes.filter((change) => change.status !== "unchanged");
  out.emit({
    type: "done",
    message:
      changed.length === 0 && agentsMd === "mentions"
        ? "The skills are up to date"
        : `Updated the skills: ${changed.length} of ${changes.length} copies changed`,
    data: { skills, changes, agentsMd },
    display: display(changes, agentsMd),
  });
}

/** One line per copy, then what happened to AGENTS.md when it changed. */
function display(changes: SkillCopyChange[], agentsMd: string): string {
  const width = Math.max(...changes.map((change) => change.path.length));
  const lines = changes.map((change) => {
    const files = [
      change.added.length > 0 && change.status !== "added" ? `${change.added.length} added` : null,
      change.updated.length > 0 ? `${change.updated.length} changed` : null,
      change.removed.length > 0 ? `${change.removed.length} removed` : null,
      change.wasLink ? "was a link" : null,
    ].filter(Boolean);
    const detail =
      change.status === "added"
        ? plural(change.added.length, "file")
        : files.length > 0
          ? `files: ${files.join(", ")}`
          : "";
    return `  ${change.status.padEnd(9)} ${change.path.padEnd(width)}${detail ? `  ${detail}` : ""}`.trimEnd();
  });
  const agents =
    agentsMd === "created"
      ? ["  AGENTS.md created, pointing at each skill"]
      : agentsMd === "added"
        ? ["  AGENTS.md gained a line for each skill it didn't mention"]
        : [];
  const same = changes.every((change) => change.status === "unchanged") && agents.length === 0;
  return [same ? "The skills are up to date:" : "Updated the skills:", ...lines, ...agents].join("\n");
}
