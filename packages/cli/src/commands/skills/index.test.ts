import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSkill, skillsSource } from "@/lib/app/skill";
import { checkoutRoot } from "@/lib/checkout";
import { createHumanSink, createNdjsonSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { updateSkills } from "./index";

const skillsDir = skillsSource(checkoutRoot());
let appDir: string;

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-skills-update-"));
  fs.writeFileSync(path.join(appDir, "everyapp.config.ts"), 'export default { id: "todo" };\n');
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

/** `everyapp skills update --json` in `cwd`: its events. */
async function run(cwd = appDir): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const out = createNdjsonSink((line) => lines.push(line));
  try {
    await updateSkills({ cwd, out, skillsDir });
  } catch (error) {
    reportFailure(out, error);
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

type Change = { skill: string; path: string; status: string; added: string[]; updated: string[]; removed: string[] };
const changesOf = (events: Record<string, unknown>[]) =>
  (events.at(-1)!["data"] as { changes: Change[] }).changes;
const byPath = (changes: Change[]) => Object.fromEntries(changes.map((change) => [change.path, change]));
const shipped = (relative: string) => fs.readFileSync(path.join(skillsDir, relative), "utf8");

describe("everyapp skills update", () => {
  it("leaves the copies create made alone: nothing to update", async () => {
    await linkSkill({ skillsDir, appDir });
    const before = fs.statSync(path.join(appDir, ".agents/skills/everyapp/SKILL.md")).mtimeMs;

    const events = await run();

    expect(events.at(-1)).toMatchObject({ type: "done", message: "The skills are up to date" });
    expect(changesOf(events).map((change) => change.status)).toEqual(Array(4).fill("unchanged"));
    expect(fs.statSync(path.join(appDir, ".agents/skills/everyapp/SKILL.md")).mtimeMs).toBe(before);
  });

  it("replaces a stale copy whole, adds a missing skill, and leaves other skills alone", async () => {
    await linkSkill({ skillsDir, appDir });
    const everyapp = path.join(appDir, ".claude/skills/everyapp");
    fs.writeFileSync(path.join(everyapp, "SKILL.md"), "old\n");
    fs.rmSync(path.join(everyapp, "mcp.md"));
    fs.writeFileSync(path.join(everyapp, "retired.md"), "no longer shipped\n");
    fs.rmSync(path.join(appDir, ".agents/skills/build-every-app"), { recursive: true });
    fs.mkdirSync(path.join(appDir, ".agents/skills/mine"));
    fs.writeFileSync(path.join(appDir, ".agents/skills/mine/SKILL.md"), "ours\n");

    const events = await run();

    const changes = byPath(changesOf(events));
    expect(changes[".claude/skills/everyapp"]).toMatchObject({
      status: "updated",
      added: ["mcp.md"],
      updated: ["SKILL.md"],
      removed: ["retired.md"],
    });
    expect(changes[".agents/skills/build-every-app"]).toMatchObject({
      status: "added",
      added: ["SKILL.md", "patterns.md"],
    });
    expect(changes[".agents/skills/everyapp"]!.status).toBe("unchanged");
    expect(Object.keys(changes)).not.toContain(".agents/skills/mine");
    expect(fs.readFileSync(path.join(everyapp, "SKILL.md"), "utf8")).toBe(shipped("everyapp/SKILL.md"));
    expect(fs.existsSync(path.join(everyapp, "retired.md"))).toBe(false);
    expect(fs.readFileSync(path.join(appDir, ".agents/skills/build-every-app/patterns.md"), "utf8")).toBe(
      shipped("build-every-app/patterns.md"),
    );
    expect(fs.readFileSync(path.join(appDir, ".agents/skills/mine/SKILL.md"), "utf8")).toBe("ours\n");
    expect(events.at(-1)).toMatchObject({ message: "Updated the skills: 2 of 4 copies changed", data: { agentsMd: "mentions" } });
  });

  it("brings an app with no skills the skills, and AGENTS.md lines for each", async () => {
    fs.writeFileSync(path.join(appDir, "AGENTS.md"), "# Ours\n\n- Read skills/everyapp first.\n");

    const events = await run();

    expect(changesOf(events).map((change) => change.status)).toEqual(Array(4).fill("added"));
    expect(events.at(-1)).toMatchObject({ data: { agentsMd: "added", skills: ["everyapp", "build-every-app"] } });
    expect(fs.readFileSync(path.join(appDir, "AGENTS.md"), "utf8")).toContain("build-every-app skill");
  });

  it("replaces a linked copy with a plain one", async () => {
    fs.mkdirSync(path.join(appDir, ".claude/skills"), { recursive: true });
    fs.symlinkSync(path.join(skillsDir, "everyapp"), path.join(appDir, ".claude/skills/everyapp"));

    const events = await run();

    expect(byPath(changesOf(events))[".claude/skills/everyapp"]).toMatchObject({ status: "updated", wasLink: true });
    expect(fs.lstatSync(path.join(appDir, ".claude/skills/everyapp")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, "everyapp", "SKILL.md"))).toBe(true);
  });

  it("refuses outside an app directory", async () => {
    fs.rmSync(path.join(appDir, "everyapp.config.ts"));

    const events = await run();

    expect(events.at(-1)).toMatchObject({ type: "error", code: "MANIFEST_NOT_FOUND" });
    expect(fs.existsSync(path.join(appDir, ".claude"))).toBe(false);
  });

  it("tells a person each copy and what changed in it", async () => {
    await linkSkill({ skillsDir, appDir });
    fs.writeFileSync(path.join(appDir, ".agents/skills/everyapp/stale.md"), "x\n");
    const written: string[] = [];
    const out = createHumanSink({ write: (chunk: string) => written.push(chunk), terminal: false });

    await updateSkills({ cwd: appDir, out, skillsDir });

    const said = stripVTControlCharacters(written.join(""));
    expect(said).toContain("Updated the skills:");
    expect(said).toMatch(/updated\s+\.agents\/skills\/everyapp\s+files: 1 removed/);
    expect(said).toMatch(/unchanged\s+\.claude\/skills\/build-every-app/);
  });
});
