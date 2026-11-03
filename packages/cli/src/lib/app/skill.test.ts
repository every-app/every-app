import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { linkSkills, shippedSkills, skillsSource } from "./skill";

let appDir: string;
const root = checkoutRoot();

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

  it("are links where Claude Code and other agents look, into the app's own install of the CLI", async () => {
    const result = await linkSkills({ skillsDir: skillsSource(root), appDir });

    expect(result).toEqual({
      skills: ["everyapp", "build-every-app"],
      linked: true,
      paths: [
        ".claude/skills/everyapp",
        ".agents/skills/everyapp",
        ".claude/skills/build-every-app",
        ".agents/skills/build-every-app",
      ],
    });
    for (const relative of result.paths) {
      const name = path.posix.basename(relative);
      expect(fs.readlinkSync(path.join(appDir, relative))).toBe(`../../node_modules/everyapp/skills/${name}`);
    }
    // Dangling until the install; then each is the CLI package's own skill.
    expect(fs.existsSync(path.join(appDir, ".agents", "skills", "everyapp", "SKILL.md"))).toBe(false);
    fs.mkdirSync(path.join(appDir, "node_modules"));
    fs.symlinkSync(path.join(root, "packages", "cli"), path.join(appDir, "node_modules", "everyapp"), "dir");
    for (const name of result.skills) {
      const shipped = fs.readFileSync(path.join(skillsSource(root), name, "SKILL.md"), "utf8");
      expect(fs.readFileSync(path.join(appDir, ".claude", "skills", name, "SKILL.md"), "utf8")).toBe(shipped);
      expect(fs.readFileSync(path.join(appDir, ".agents", "skills", name, "SKILL.md"), "utf8")).toBe(shipped);
    }
    expect(fs.existsSync(path.join(appDir, ".agents", "skills", "everyapp", "setup", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, ".claude", "skills", "build-every-app", "patterns.md"))).toBe(true);
  });

  it("leaves the app's own skills alone and replaces an old copy with the link", async () => {
    fs.mkdirSync(path.join(appDir, ".agents", "skills", "mine"), { recursive: true });
    fs.writeFileSync(path.join(appDir, ".agents", "skills", "mine", "SKILL.md"), "ours\n");
    fs.mkdirSync(path.join(appDir, ".claude", "skills", "everyapp"), { recursive: true });
    fs.writeFileSync(path.join(appDir, ".claude", "skills", "everyapp", "SKILL.md"), "stale copy\n");

    await linkSkills({ skillsDir: skillsSource(root), appDir });

    expect(fs.readFileSync(path.join(appDir, ".agents", "skills", "mine", "SKILL.md"), "utf8")).toBe("ours\n");
    expect(fs.lstatSync(path.join(appDir, ".claude", "skills", "everyapp")).isSymbolicLink()).toBe(true);
  });

  it("are skipped, not half-made, where the system doesn't allow links", async () => {
    let calls = 0;
    const result = await linkSkills({
      skillsDir: skillsSource(root),
      appDir,
      symlink: async (target, linkPath, type) => {
        calls += 1;
        if (calls > 1) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        fs.symlinkSync(target, linkPath, type);
      },
    });

    expect(result).toEqual({ skills: ["everyapp", "build-every-app"], paths: [], linked: false });
    expect(fs.readdirSync(path.join(appDir, ".claude", "skills"))).toEqual([]);
    expect(fs.readdirSync(path.join(appDir, ".agents", "skills"))).toEqual([]);
  });

  it("still fail on any other error", async () => {
    await expect(
      linkSkills({
        skillsDir: skillsSource(root),
        appDir,
        symlink: async () => {
          throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
        },
      }),
    ).rejects.toThrow("no space left");
  });
});
