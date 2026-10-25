/**
 * The skills shipped with the CLI (every directory under packages/cli/skills
 * with a SKILL.md: everyapp, which drives the CLI, and build-every-app, which
 * builds and changes apps) in a new app, where coding agents look for
 * skills: `.claude/skills/<name>` and `.agents/skills/<name>`. Copies, not
 * symlinks: an app outside the checkout is its own repository, where a link
 * into the checkout (or node_modules) breaks for anyone who clones it, and
 * git on Windows checks symlinks out as plain files. `create` copies them
 * again for each new app, so a newer CLI's skills reach new apps.
 *
 * AGENTS.md points at each skill. The starter's own AGENTS.md already does;
 * one that is missing is written, and one that doesn't mention a skill gets
 * its line (it is the new app's copy of the template's, not the person's).
 */
import fs from "node:fs/promises";
import path from "node:path";

const SKILL_ROOTS = [".claude/skills", ".agents/skills"];

/** The AGENTS.md line for each skill the CLI ships, in the order they are added. */
const POINTERS: Readonly<Record<string, string>> = {
  everyapp:
    "- Before running everyapp, read the everyapp skill: `.agents/skills/everyapp/SKILL.md` (also in `.claude/skills/`).",
  "build-every-app":
    "- To build or change this app, read the build-every-app skill: `.agents/skills/build-every-app/SKILL.md` (patterns in patterns.md beside it).",
};

/** The skills shipped with the CLI in the checkout at `root`. */
export function skillsSource(root: string): string {
  return path.join(root, "packages", "cli", "skills");
}

/**
 * The names of the skills shipped with the CLI: every directory under
 * skills/ with a SKILL.md, the ones with a pointer line first (in its
 * order), then any other by name.
 */
export async function shippedSkills(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(skillsSource(root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(skillsSource(root), entry.name, "SKILL.md"));
      found.push(entry.name);
    } catch {
      // A directory without a SKILL.md isn't a skill.
    }
  }
  const known = Object.keys(POINTERS).filter((name) => found.includes(name));
  const other = found.filter((name) => !(name in POINTERS)).sort();
  return [...known, ...other];
}

/** The AGENTS.md line that points at `name`. */
function pointer(name: string): string {
  return POINTERS[name] ?? `- Read the ${name} skill: \`.agents/skills/${name}/SKILL.md\` (also in \`.claude/skills/\`).`;
}

/** What happened to the app's AGENTS.md. */
type AgentsMd = "mentions" | "created" | "added";

export async function linkSkill({
  root,
  appDir,
}: {
  root: string;
  appDir: string;
}): Promise<{ skills: string[]; paths: string[]; agentsMd: AgentsMd }> {
  const skills = await shippedSkills(root);
  const paths: string[] = [];
  for (const name of skills) {
    for (const base of SKILL_ROOTS) {
      const relative = `${base}/${name}`;
      const target = path.join(appDir, relative);
      await fs.rm(target, { recursive: true, force: true });
      await fs.cp(path.join(skillsSource(root), name), target, { recursive: true });
      paths.push(relative);
    }
  }
  return { skills, paths, agentsMd: await pointAgentsMd(appDir, skills) };
}

async function pointAgentsMd(appDir: string, skills: string[]): Promise<AgentsMd> {
  const file = path.join(appDir, "AGENTS.md");
  let current: string;
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    await fs.writeFile(file, `# Agent instructions\n\n${skills.map(pointer).join("\n")}\n`);
    return "created";
  }
  const missing = skills.filter((name) => !current.includes(`skills/${name}`));
  if (missing.length === 0) return "mentions";
  await fs.writeFile(file, `${current.replace(/\s*$/, "")}\n${missing.map(pointer).join("\n")}\n`);
  return "added";
}
