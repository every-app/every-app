import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { linkSkill, shippedSkills, skillsSource } from "./skill";

let appDir: string;
const root = checkoutRoot();
const agentsMd = () => fs.readFileSync(path.join(appDir, "AGENTS.md"), "utf8");

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-skill-"));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe("the skills in a new app", () => {
  it("are every skill the CLI ships, the one that drives the CLI first", async () => {
    expect(await shippedSkills(skillsSource(root))).toEqual(["everyapp", "build-every-app"]);
  });

  it("are copied where Claude Code and other agents look, and a new AGENTS.md points at each", async () => {
    const result = await linkSkill({ skillsDir: skillsSource(root), appDir });

    expect(result).toEqual({
      skills: ["everyapp", "build-every-app"],
      paths: [
        ".claude/skills/everyapp",
        ".agents/skills/everyapp",
        ".claude/skills/build-every-app",
        ".agents/skills/build-every-app",
      ],
      agentsMd: "created",
    });
    for (const name of result.skills) {
      const shipped = fs.readFileSync(path.join(root, "packages", "cli", "skills", name, "SKILL.md"), "utf8");
      for (const dir of result.paths.filter((relative) => relative.endsWith(`/${name}`))) {
        // A copy, not a link: it survives a clone of the app on its own.
        expect(fs.lstatSync(path.join(appDir, dir)).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(path.join(appDir, dir, "SKILL.md"), "utf8")).toBe(shipped);
      }
    }
    // The files beside each SKILL.md come along.
    expect(fs.existsSync(path.join(appDir, ".agents", "skills", "everyapp", "setup", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, ".claude", "skills", "build-every-app", "patterns.md"))).toBe(true);
    expect(agentsMd()).toBe(
      [
        "# Agent instructions",
        "",
        "- Before running everyapp, read the everyapp skill: `.agents/skills/everyapp/SKILL.md` (also in `.claude/skills/`).",
        "- To build or change this app, read the build-every-app skill: `.agents/skills/build-every-app/SKILL.md` (patterns in patterns.md beside it).",
        "",
      ].join("\n"),
    );
  });

  it("leaves an AGENTS.md that mentions every skill alone", async () => {
    fs.writeFileSync(path.join(appDir, "AGENTS.md"), "- Read skills/everyapp first.\n- Then skills/build-every-app.\n");

    const result = await linkSkill({ skillsDir: skillsSource(root), appDir });

    expect(result.agentsMd).toBe("mentions");
    expect(agentsMd()).toBe("- Read skills/everyapp first.\n- Then skills/build-every-app.\n");
  });

  it("adds a line for each skill an AGENTS.md doesn't mention", async () => {
    fs.writeFileSync(path.join(appDir, "AGENTS.md"), "# Ours\n\n- Use tabs.\n");

    await expect(linkSkill({ skillsDir: skillsSource(root), appDir })).resolves.toMatchObject({ agentsMd: "added" });
    expect(agentsMd()).toMatch(
      /^# Ours\n\n- Use tabs\.\n- Before running everyapp, read the everyapp skill[^\n]*\n- To build or change this app, read the build-every-app skill[^\n]*\n$/,
    );
  });

  it("adds only the line of the skill that is missing", async () => {
    fs.writeFileSync(path.join(appDir, "AGENTS.md"), "- Read skills/everyapp first.\n");

    await expect(linkSkill({ skillsDir: skillsSource(root), appDir })).resolves.toMatchObject({ agentsMd: "added" });
    expect(agentsMd()).toMatch(
      /^- Read skills\/everyapp first\.\n- To build or change this app, read the build-every-app skill[^\n]*\n$/,
    );
  });
});
