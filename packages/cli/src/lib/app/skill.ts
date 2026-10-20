/**
 * The everyapp skill (packages/cli/skills/everyapp/SKILL.md, shipped with
 * the CLI) in a new app, where coding agents look for skills:
 * `.claude/skills/everyapp` and `.agents/skills/everyapp`. Copies, not
 * symlinks: an app outside the checkout is its own repository, where a link
 * into the checkout (or node_modules) breaks for anyone who clones it, and
 * git on Windows checks symlinks out as plain files. `create` copies it
 * again for each new app, so a newer CLI's skill reaches new apps.
 *
 * AGENTS.md points at it. The starter's own AGENTS.md already does; one
 * that is missing is written, and one that doesn't mention the skill gets
 * the line (it is the new app's copy of the template's, not the person's).
 */
import fs from "node:fs/promises";
import path from "node:path";

const SKILL_PATHS = [".claude/skills/everyapp", ".agents/skills/everyapp"];

const POINTER =
  "- Before running everyapp, read the everyapp skill: `.agents/skills/everyapp/SKILL.md` (also in `.claude/skills/`).";

/** The skill shipped with the CLI in the checkout at `root`. */
export function skillSource(root: string): string {
  return path.join(root, "packages", "cli", "skills", "everyapp");
}

/** What happened to the app's AGENTS.md. */
type AgentsMd = "mentions" | "created" | "added";

export async function linkSkill({
  root,
  appDir,
}: {
  root: string;
  appDir: string;
}): Promise<{ paths: string[]; agentsMd: AgentsMd }> {
  for (const relative of SKILL_PATHS) {
    const target = path.join(appDir, relative);
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(skillSource(root), target, { recursive: true });
  }
  return { paths: SKILL_PATHS, agentsMd: await pointAgentsMd(appDir) };
}

async function pointAgentsMd(appDir: string): Promise<AgentsMd> {
  const file = path.join(appDir, "AGENTS.md");
  let current: string;
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    await fs.writeFile(file, `# Agent instructions\n\n${POINTER}\n`);
    return "created";
  }
  if (current.includes("skills/everyapp")) return "mentions";
  await fs.writeFile(file, `${current.replace(/\s*$/, "")}\n${POINTER}\n`);
  return "added";
}
