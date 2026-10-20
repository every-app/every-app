import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { linkSkill } from "./skill";

let appDir: string;
const root = checkoutRoot();
const agentsMd = () => fs.readFileSync(path.join(appDir, "AGENTS.md"), "utf8");

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-skill-"));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe("the everyapp skill in a new app", () => {
  it("is copied where Claude Code and other agents look, and a new AGENTS.md points at it", async () => {
    const result = await linkSkill({ root, appDir });

    expect(result).toEqual({
      paths: [".claude/skills/everyapp", ".agents/skills/everyapp"],
      agentsMd: "created",
    });
    const shipped = fs.readFileSync(
      path.join(root, "packages", "cli", "skills", "everyapp", "SKILL.md"),
      "utf8",
    );
    for (const dir of result.paths) {
      // A copy, not a link: it survives a clone of the app on its own.
      expect(fs.lstatSync(path.join(appDir, dir)).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(appDir, dir, "SKILL.md"), "utf8")).toBe(shipped);
    }
    expect(agentsMd()).toContain(".agents/skills/everyapp/SKILL.md");
  });

  it("leaves an AGENTS.md that mentions it alone", async () => {
    fs.writeFileSync(path.join(appDir, "AGENTS.md"), "- Read skills/everyapp first.\n");

    const result = await linkSkill({ root, appDir });

    expect(result.agentsMd).toBe("mentions");
    expect(agentsMd()).toBe("- Read skills/everyapp first.\n");
  });

  it("adds the line to an AGENTS.md that doesn't mention it", async () => {
    fs.writeFileSync(path.join(appDir, "AGENTS.md"), "# Ours\n\n- Use tabs.\n");

    await expect(linkSkill({ root, appDir })).resolves.toMatchObject({ agentsMd: "added" });
    expect(agentsMd()).toMatch(/^# Ours\n\n- Use tabs\.\n- Before running everyapp, read the everyapp skill/);
  });
});
