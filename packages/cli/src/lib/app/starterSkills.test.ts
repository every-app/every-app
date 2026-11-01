/**
 * The starter names the skills `everyapp create` copies into a new app: its
 * first screen (starter/src/routes/index.tsx) names the build skill, its
 * README names every skill and the directories they are copied to. They are
 * prose, not read from the CLI, so this holds them to what linkSkill() does
 * (skill.ts): a skill the starter names is one the CLI ships, and the README
 * names every shipped skill and every directory, no other.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { linkSkill, skillsSource } from "./skill";

const root = checkoutRoot();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

/** The backticked spans of a Markdown file. */
const spans = (markdown: string) => [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);

/** What `everyapp create` copies: the skill names, and the directories (with their slash) it copies them to. */
let shipped: string[];
let roots: string[];

beforeAll(async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-starter-skills-"));
  try {
    const { paths } = await linkSkill({ skillsDir: skillsSource(root), appDir });
    shipped = [...new Set(paths.map((relative) => path.posix.basename(relative)))];
    roots = [...new Set(paths.map((relative) => `${path.posix.dirname(relative)}/`))];
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

describe("the starter names the skills a new app carries", () => {
  it("on the first screen: the build skill is one the CLI ships", () => {
    const named = read("starter/src/routes/index.tsx").match(/const BUILD_SKILL = "([^"]+)"/)?.[1];
    expect(named).toBeDefined();
    expect(shipped).toContain(named);
  });

  it("in the README: every shipped skill and every directory they are copied to", () => {
    const named = spans(read("starter/README.md"));
    for (const name of shipped) expect(named).toContain(name);
    for (const dir of roots) expect(named).toContain(dir);
  });

  it("in the README: no skills directory the CLI doesn't copy to", () => {
    const named = spans(read("starter/README.md")).filter((span) => /^\.[^/]+\/skills\/$/.test(span));
    expect([...new Set(named)].sort()).toEqual([...roots].sort());
  });
});
