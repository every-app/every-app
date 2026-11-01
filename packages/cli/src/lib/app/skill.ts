/**
 * The skills shipped with the CLI (every directory under packages/cli/skills
 * with a SKILL.md: everyapp, which drives the CLI, and build-every-app, which
 * builds and changes apps) in a new app, where coding agents look for
 * skills: `.claude/skills/<name>` and `.agents/skills/<name>`. Copies, not
 * symlinks: an app outside the checkout is its own repository, where a link
 * into the checkout (or node_modules) breaks for anyone who clones it, and
 * git on Windows checks symlinks out as plain files. `create` copies them
 * again for each new app, so a newer CLI's skills reach new apps, and
 * `everyapp skills update` refreshes the copies in an app made before.
 *
 * AGENTS.md points at each skill. The starter's own AGENTS.md already does;
 * one that is missing is written, and one that doesn't mention a skill gets
 * its line (it is the new app's copy of the template's, not the person's).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isNotFoundError } from "@/lib/file-operations";

const SKILL_ROOTS = [".claude/skills", ".agents/skills"];

/** The AGENTS.md line for each skill the CLI ships, in the order they are added. */
const POINTERS: Readonly<Record<string, string>> = {
  everyapp:
    "- Before running everyapp, read the everyapp skill: `.agents/skills/everyapp/SKILL.md` (also in `.claude/skills/`).",
  "build-every-app":
    "- To build or change this app, read the build-every-app skill: `.agents/skills/build-every-app/SKILL.md` (patterns in patterns.md beside it).",
};

/** The skills shipped with the CLI in the checkout at `root` (lib/checkout.ts `templateSource` says where else). */
export function skillsSource(root: string): string {
  return path.join(root, "packages", "cli", "skills");
}

/**
 * The names of the skills shipped with the CLI: every directory under
 * `skillsDir` with a SKILL.md, the ones with a pointer line first (in its
 * order), then any other by name.
 */
export async function shippedSkills(skillsDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(skillsDir, entry.name, "SKILL.md"));
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

/** A skill copy compared with what the CLI ships, before it is replaced. */
export interface SkillCopyChange {
  /** The skill's name (a directory under packages/cli/skills). */
  skill: string;
  /** Where the copy is, relative to the app: `.claude/skills/<name>` or `.agents/skills/<name>`. */
  path: string;
  /** `added`: there was none; `updated`: it differed (or was a link); `unchanged`: left as it was. */
  status: "added" | "updated" | "unchanged";
  /** Files (relative to the skill, `/`-separated) the copy gains, gets new contents for, and loses. */
  added: string[];
  updated: string[];
  removed: string[];
  /** The copy was a symbolic link; it is a plain copy now. */
  wasLink?: true;
}

/**
 * Every skill the CLI ships, copied into the app at `appDir` in both places
 * agents look, each copy replaced wholesale (a file no longer shipped goes
 * too) unless it is already the same; then AGENTS.md pointed at each.
 * Directories under the skill roots that aren't a shipped skill are left
 * alone. `create` (linkSkill) and `skills update` both run it.
 */
export async function syncSkills({
  skillsDir,
  appDir,
}: {
  /** Where the shipped skills are (lib/checkout.ts `templateSource`). */
  skillsDir: string;
  appDir: string;
}): Promise<{ skills: string[]; paths: string[]; changes: SkillCopyChange[]; agentsMd: AgentsMd }> {
  const skills = await shippedSkills(skillsDir);
  const paths: string[] = [];
  const changes: SkillCopyChange[] = [];
  for (const name of skills) {
    const source = path.join(skillsDir, name);
    const shipped = await readTree(source);
    for (const base of SKILL_ROOTS) {
      const relative = `${base}/${name}`;
      const target = path.join(appDir, relative);
      const change = await compareCopy(target, shipped);
      changes.push({ skill: name, path: relative, ...change });
      if (change.status !== "unchanged") {
        await fs.rm(target, { recursive: true, force: true });
        await fs.cp(source, target, { recursive: true });
      }
      paths.push(relative);
    }
  }
  return { skills, paths, changes, agentsMd: await pointAgentsMd(appDir, skills) };
}

/** The skills in a new app (`create`): syncSkills, said the way create's step says it. */
export async function linkSkill({
  skillsDir,
  appDir,
}: {
  /** Where the shipped skills are (lib/checkout.ts `templateSource`). */
  skillsDir: string;
  appDir: string;
}): Promise<{ skills: string[]; paths: string[]; agentsMd: AgentsMd }> {
  const { skills, paths, agentsMd } = await syncSkills({ skillsDir, appDir });
  return { skills, paths, agentsMd };
}

/** Every file under `dir` (relative, `/`-separated, sorted) and its contents; empty when there is no `dir`. */
async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { recursive: true });
  } catch (error) {
    if (isNotFoundError(error)) return files;
    throw error;
  }
  for (const entry of entries.sort()) {
    const file = path.join(dir, entry);
    if (!(await fs.stat(file)).isFile()) continue;
    files.set(entry.split(path.sep).join("/"), await fs.readFile(file));
  }
  return files;
}

/** How the copy at `target` differs from the shipped files. */
async function compareCopy(
  target: string,
  shipped: Map<string, Buffer>,
): Promise<Omit<SkillCopyChange, "skill" | "path">> {
  let wasLink: boolean;
  try {
    wasLink = (await fs.lstat(target)).isSymbolicLink();
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    return { status: "added", added: [...shipped.keys()], updated: [], removed: [] };
  }
  // A link is replaced by a copy whatever it points at (a dangling one reads as empty).
  const current = await readTree(target).catch(() => new Map<string, Buffer>());
  const added = [...shipped.keys()].filter((file) => !current.has(file));
  const updated = [...shipped.keys()].filter(
    (file) => current.has(file) && !current.get(file)!.equals(shipped.get(file)!),
  );
  const removed = [...current.keys()].filter((file) => !shipped.has(file));
  const same = added.length === 0 && updated.length === 0 && removed.length === 0;
  return {
    status: same && !wasLink ? "unchanged" : "updated",
    added,
    updated,
    removed,
    ...(wasLink ? { wasLink: true as const } : {}),
  };
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
