/**
 * The build-every-app skill (skills/build-every-app/SKILL.md and the
 * patterns index beside it) stays honest about what it points at: the
 * frontmatter a harness reads, the two addresses every agent is sent to
 * (llms.txt and the patterns page), the agent pages it names, every
 * `pnpm everyapp …` a route the CLI has, every `starter/` path a file of the
 * starter, every path into one of the four open apps a file of that app's
 * checkout when the checkout is on this machine (skipped, with the reason,
 * when it isn't, so CI passes), no sentence that asks for a value through
 * the chat, and every pattern SKILL.md's short table names indexed in
 * patterns.md. repoDocs.test.ts checks the checkout paths and the flags.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandPaths } from "@/app";
import { checkoutRoot } from "@/lib/checkout";
import { asksForSecretInChat } from "../../../test/shared/chat-secret.mjs";

const root = checkoutRoot();
const skillDir = path.join(root, "packages", "cli", "skills", "build-every-app");
const read = (name: string) => {
  const file = path.join(skillDir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};
const skill = read("SKILL.md");
const patterns = read("patterns.md");
const files = [
  { name: "SKILL.md", text: skill },
  { name: "patterns.md", text: patterns },
];

/**
 * Where the checkouts of the four apps sit on this machine, from
 * EVERYAPP_APP_CHECKOUTS: a directory holding them under the names the
 * patterns cite (their public repository names), comma-separated
 * `name=path` pairs for clones kept elsewhere or under another name, or
 * both. Without it, ~/workspaces by the account's real home (the test setup
 * gives every test an empty HOME, so not os.homedir()).
 */
const CHECKOUT_ENTRIES = (process.env["EVERYAPP_APP_CHECKOUTS"] ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const checkoutsDir = CHECKOUT_ENTRIES.filter((entry) => !entry.includes("=")).at(-1) ?? path.join(os.userInfo().homedir, "workspaces");
const namedCheckouts = new Map(
  CHECKOUT_ENTRIES.filter((entry) => entry.includes("=")).map((entry) => {
    const eq = entry.indexOf("=");
    return [entry.slice(0, eq).trim(), entry.slice(eq + 1).trim()] as const;
  }),
);

/** The four apps the patterns cite, by the name they are cited under (their public repository names). */
const APP_NAMES = ["open-crm", "open-analytics", "open-seo", "agentic-inbox"];

/**
 * An app's checkout here: the path its `name=path` pair names, else
 * `<checkoutsDir>/<app>`; checked only when it holds an `everyapp.config.ts`
 * (a clone of the app before its port has none). With the commit it is at,
 * so the test's title says which tree the citations were checked against.
 */
function checkoutFor(app: string): { dir: string; commit: string } | { skipped: string } {
  const dir = namedCheckouts.get(app) ?? path.join(checkoutsDir, app);
  if (!fs.existsSync(dir)) return { skipped: `no checkout at ${dir}` };
  if (!fs.existsSync(path.join(dir, "everyapp.config.ts"))) return { skipped: `${dir} has no everyapp.config.ts` };
  let commit = "unknown commit";
  try {
    commit = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Not a git checkout: the files are still checked.
  }
  return { dir, commit };
}

/** The agent pages "Read first" sends the agent to, by their slug. */
const AGENT_PAGES = ["manifest", "identity", "secrets", "mcp", "dev", "deploy", "email"];

const FORBIDDEN_PHRASES = ["paste the key", "paste it here", "send me the", "what is your key"];

/** The backticked spans of `text`, each with its line number. */
function spans(text: string): Array<{ line: number; span: string }> {
  const out: Array<{ line: number; span: string }> = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) out.push({ line: index + 1, span: match[1]! });
  });
  return out;
}

/**
 * The paths under `prefix/` a file cites in backticks, each once: a span
 * that is one path, with no glob, placeholder or space in it.
 */
function citedPaths(text: string, prefix: string): Array<{ line: number; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ line: number; path: string }> = [];
  for (const { line, span } of spans(text)) {
    const cited = span.trim().replace(/[.,;:)]+$/, "");
    if (!cited.startsWith(`${prefix}/`) || /[\s<>*{}…]/.test(cited) || seen.has(cited)) continue;
    seen.add(cited);
    out.push({ line, path: cited });
  }
  return out;
}

/** The first cell of every body row of the tables in `text`. */
function tableRowNames(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\|/.test(line) && !/^\|\s*-/.test(line) && !/^\|\s*Pattern\s*\|/.test(line))
    .map((line) => line.split("|")[1]!.trim())
    .filter(Boolean);
}

describe("the build-every-app skill", () => {
  it("has the frontmatter a harness picks it by, and stays short", () => {
    expect(skill, `${skillDir}/SKILL.md is missing`).not.toBe("");
    expect(skill).toMatch(/^---\nname: build-every-app\ndescription: .{40,}\n---\n/);
    // 14 KB: the security review's two paths, the workspace one-liner and
    // both create forms (main's rulings of 2026-10-25) took it past 13.
    expect(Buffer.byteLength(skill)).toBeLessThan(14 * 1024);
  });

  it("sends the agent to llms.txt, the agent pages for the job, the everyapp skill and the patterns index", () => {
    expect(skill).toContain("https://everyapp.com/llms.txt");
    expect(skill).toContain("https://everyapp.com/docs/agent/patterns");
    expect(skill).toContain(".agents/skills/build-every-app/patterns.md");
    expect(skill).toContain("everyapp skill");
    for (const slug of AGENT_PAGES) {
      expect(skill, `SKILL.md names the ${slug} page`).toMatch(new RegExp(`\\b${slug}\\b`));
      expect(fs.existsSync(path.join(root, "landing-page", "content", "agent", `${slug}.md`)), slug).toBe(true);
    }
    expect(patterns, `${skillDir}/patterns.md is missing`).not.toBe("");
  });

  it("names every pattern of its short table in patterns.md", () => {
    const names = tableRowNames(skill);
    expect(names.length).toBeGreaterThanOrEqual(10);
    const missing = names.filter((name) => !patterns.toLowerCase().includes(name.toLowerCase()));
    expect(missing).toEqual([]);
  });

  it("is pointed at by the starter's AGENTS.md", () => {
    const agents = fs.readFileSync(path.join(root, "starter", "AGENTS.md"), "utf8");
    expect(agents).toContain(".agents/skills/build-every-app/SKILL.md");
    expect(agents).toContain(".agents/skills/everyapp/SKILL.md");
  });
});

describe("the skill and the patterns index", () => {
  it("run only commands the CLI has", () => {
    const paths = new Set(commandPaths());
    const groups = new Set([...paths].filter((route) => route.includes(" ")).map((route) => route.split(" ")[0]!));
    const problems: string[] = [];
    for (const file of files) {
      file.text.split("\n").forEach((line, index) => {
        for (const match of line.matchAll(/(?:pnpm |npx )everyapp ([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
          const [, command, sub] = match;
          const route = groups.has(command!) && sub ? `${command} ${sub}` : command!;
          if (!paths.has(route)) problems.push(`${file.name}:${index + 1} pnpm everyapp ${route}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it("never ask for a value through the chat", () => {
    // The phrase list, and the detector the claude -p harnesses flag an
    // agent's turn with (test/shared/chat-secret.mjs): a sentence the skill
    // writes is one an agent may repeat.
    const problems: string[] = [];
    for (const file of files) {
      file.text.split("\n").forEach((line, index) => {
        const lower = line.toLowerCase();
        for (const phrase of FORBIDDEN_PHRASES) {
          if (lower.includes(phrase)) problems.push(`${file.name}:${index + 1} says "${phrase}"`);
        }
        const ask = asksForSecretInChat(line);
        if (ask) problems.push(`${file.name}:${index + 1} asks "${ask}"`);
      });
    }
    expect(problems).toEqual([]);
  });

  it("cite only starter files that exist", () => {
    const problems: string[] = [];
    for (const file of files) {
      for (const { line, path: cited } of citedPaths(file.text, "starter")) {
        if (!fs.existsSync(path.join(root, cited))) problems.push(`${file.name}:${line} ${cited}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("names only starter files in SKILL.md's app-relative paths", () => {
    // "The shape of an app" and the rules name files as they sit in an app
    // (`src/…`, `drizzle/`, `*.config.ts`, `*.d.ts`): each is a file or
    // directory of the starter, so a starter rename can't leave the skill stale.
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const { line, span } of spans(skill)) {
      const raw = span.trim().replace(/[.,;:)]+$/, "");
      if (!/^(?:src|drizzle)\/|\.config\.ts$|\.d\.ts$/.test(raw) || /[\s<>*{}…]/.test(raw)) continue;
      const cited = raw.replace(/\/$/, "");
      if (seen.has(cited)) continue;
      seen.add(cited);
      if (!fs.existsSync(path.join(root, "starter", cited))) problems.push(`SKILL.md:${line} ${cited}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(15);
    expect(problems).toEqual([]);
  });

  it("cite a file in each of the four apps", () => {
    for (const app of APP_NAMES) {
      expect(citedPaths(patterns, app).length, `patterns.md cites ${app}/`).toBeGreaterThan(0);
    }
  });

  for (const app of APP_NAMES) {
    const checkout = checkoutFor(app);
    const dir = "dir" in checkout ? checkout.dir : undefined;
    const where = "dir" in checkout ? `${checkout.dir} at ${checkout.commit}` : `${checkout.skipped}: not checked here`;
    it.skipIf(!dir)(`cite only files that exist in ${app} (${where})`, () => {
      const problems: string[] = [];
      for (const file of files) {
        for (const { line, path: cited } of citedPaths(file.text, app)) {
          const inside = cited.slice(app.length + 1);
          if (!fs.existsSync(path.join(dir!, inside))) problems.push(`${file.name}:${line} ${cited}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
