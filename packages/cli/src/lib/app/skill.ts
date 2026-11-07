/**
 * The skills shipped with the CLI (every directory under packages/cli/skills
 * with a SKILL.md: everyapp, which drives the CLI, and build-every-app, which
 * builds and changes apps) in a new app, where coding agents look for
 * skills: `.claude/skills/<name>` (Claude Code) and `.agents/skills/<name>`
 * (Codex and others). Each is a relative link to
 * `node_modules/everyapp/skills/<name>`, the copy inside the CLI package the
 * app pins, so the skills always match that CLI. They are short and point
 * at the agent docs on everyapp.com, which change without an upgrade. The
 * links resolve once `pnpm install` has run. Both tools follow a linked skill
 * directory (checked with Claude Code 2.1.316 and Codex 0.165.0). Where a
 * link can't be made (Windows without Developer Mode or admin rights), create
 * skips the links rather than failing: the app's AGENTS.md names the
 * `node_modules` path too.
 */
import fs from "node:fs/promises";
import path from "node:path";

const SKILL_ROOTS = [".claude/skills", ".agents/skills"];

/** Where the skills are inside an app, relative to the app: the CLI package's own copy. */
const INSTALLED_SKILLS = "node_modules/everyapp/skills";

/** The errors `symlink` gives where the system doesn't allow links; any other error is a real failure. */
const LINKS_UNSUPPORTED = new Set(["EPERM", "EACCES", "ENOTSUP", "ENOSYS"]);

/** The order the shipped skills are listed in: the one that drives the CLI first. */
const ORDER = ["everyapp", "build-every-app"];

/** The skills shipped with the CLI in the checkout at `root` (lib/checkout.ts `templateSource` says where else). */
export function skillsSource(root: string): string {
  return path.join(root, "packages", "cli", "skills");
}

/**
 * The names of the skills shipped with the CLI: every directory under
 * `skillsDir` with a SKILL.md, the known ones first (in their order), then
 * any other by name.
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
  const known = ORDER.filter((name) => found.includes(name));
  const other = found.filter((name) => !ORDER.includes(name)).sort();
  return [...known, ...other];
}

/**
 * Every skill the CLI ships, linked into the new app at `appDir` in both
 * places agents look: `<root>/<name>` → `../../node_modules/everyapp/skills/<name>`.
 * `skillsDir` only says which skills there are; the links point into the
 * app's own install of the CLI, not at `skillsDir`. Where the system doesn't
 * allow links, `linked` is false, `paths` is empty and nothing is left
 * half-made: agents find the skills through the app's AGENTS.md.
 */
export async function linkSkills({
  skillsDir,
  appDir,
  symlink = fs.symlink,
}: {
  /** Where the shipped skills are (lib/checkout.ts `templateSource`). */
  skillsDir: string;
  appDir: string;
  /** Makes one link; tests replace it. */
  symlink?: (target: string, linkPath: string, type: "dir") => Promise<void>;
}): Promise<{ skills: string[]; paths: string[]; linked: boolean }> {
  const skills = await shippedSkills(skillsDir);
  const paths: string[] = [];
  for (const base of SKILL_ROOTS) {
    await fs.mkdir(path.join(appDir, base), { recursive: true });
  }
  for (const name of skills) {
    for (const base of SKILL_ROOTS) {
      const relative = `${base}/${name}`;
      const target = path.join(appDir, relative);
      await fs.rm(target, { recursive: true, force: true });
      try {
        await symlink(`../../${INSTALLED_SKILLS}/${name}`, target, "dir");
      } catch (error) {
        if (!LINKS_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        for (const made of paths) await fs.rm(path.join(appDir, made), { force: true });
        return { skills, paths: [], linked: false };
      }
      paths.push(relative);
    }
  }
  return { skills, paths, linked: true };
}

/** Where an agent reads a shipped skill when the links couldn't be made. */
export function installedSkillPath(name: string): string {
  return `${INSTALLED_SKILLS}/${name}/SKILL.md`;
}
