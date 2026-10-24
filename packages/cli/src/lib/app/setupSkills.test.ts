/**
 * The setup files of the everyapp skill (skills/everyapp/setup/*.md) stay
 * honest about the CLI they describe: every file the index names exists
 * and every file is indexed; every `secret set NAME` names a Gateway
 * setting the CLI accepts; every `pnpm everyapp …` is a route the CLI has;
 * no file asks for a value through the chat or puts one on a command
 * line; and each file has the sections the README's contract requires.
 * The end-to-end harness in test/setup-skills/ (not run here) drives
 * `claude -p` through the same files.
 */
import fs from "node:fs";
import path from "node:path";
import { SETTABLE_GATEWAY_SETTINGS } from "@every-app/sdk/internal";
import { describe, expect, it } from "vitest";
import { commandPaths } from "@/app";
import { checkoutRoot } from "@/lib/checkout";

const setupDir = path.join(checkoutRoot(), "packages", "cli", "skills", "everyapp", "setup");
const readmeFile = path.join(setupDir, "README.md");
const readme = fs.existsSync(readmeFile) ? fs.readFileSync(readmeFile, "utf8") : "";

/** The setup files beside the README, each with its lines. */
const files = (fs.existsSync(setupDir) ? fs.readdirSync(setupDir) : [])
  .filter((name) => name.endsWith(".md") && name !== "README.md")
  .sort()
  .map((name) => ({ name, text: fs.readFileSync(path.join(setupDir, name), "utf8") }));

/** README.md and the setup files: the rules about commands and values hold in all of them. */
const allFiles = [...(readme ? [{ name: "README.md", text: readme }] : []), ...files];

/** Routes the files may name that aren't on main yet, each with why. */
const REQUIRED_HEADINGS = [
  "Settings",
  "Costs and plans",
  "Only a person can",
  "Before you start",
  "Steps",
  "Verify",
  "If it fails",
  "Rerun, rotate, remove",
  "Sources",
];

const FORBIDDEN_PHRASES = ["paste the key", "paste it here", "send me the", "what is your key"];

const settable: ReadonlySet<string> = new Set(SETTABLE_GATEWAY_SETTINGS);

/** `NAME`, `<name>`, `NAME…`: a placeholder, not a setting. */
function isPlaceholder(token: string): boolean {
  return /^<.*>$/.test(token) || /^NAMES?(?:…|\.\.\.)?$/.test(token) || token.includes("…");
}

/** Every `secret set|unset` in `text`, with the names given before any flag. */
function secretCalls(text: string): Array<{ action: string; names: string[]; line: number }> {
  const calls: Array<{ action: string; names: string[]; line: number }> = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/(?:pnpm |npx )?everyapp secret (set|unset)((?:\s+(?:[A-Z][A-Z0-9_]*|<[^>]+>|NAMES?…?))*)/g)) {
      const names = match[2]!.trim().split(/\s+/).filter(Boolean);
      calls.push({ action: match[1]!, names, line: index + 1 });
    }
  });
  return calls;
}

/**
 * What follows `secret set` on a line, token by token, until the command
 * ends (a backtick, a pipe, `;`, `&&`, `)`, end of line): a quoted string
 * or an `=` there is a value on the command line.
 */
function valueAfterSecretSet(line: string): string | null {
  for (const match of line.matchAll(/everyapp secret set\b([^`|;)&\n]*)/g)) {
    const tokens = match[1]!.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.startsWith("--")) {
        // A flag and, when it takes one, its value.
        if (!token.includes("=") && /^--(?:from-env|gateway|account-id)$/.test(token)) i++;
        continue;
      }
      if (/^["'].*|.*=.*$/.test(token)) return token;
    }
  }
  return null;
}

describe("the setup index", () => {
  it("links every setup file, and every linked file exists", () => {
    expect(readme, `${readmeFile} is missing`).not.toBe("");
    const linked = [...readme.matchAll(/\[([a-z0-9-]+\.md)\]\(([a-z0-9-]+\.md)\)/g)].map((match) => match[2]!);
    expect(linked.length, "the README's table links no files").toBeGreaterThan(0);
    const missing = linked.filter((name) => !fs.existsSync(path.join(setupDir, name)));
    const unlisted = files.map((file) => file.name).filter((name) => !linked.includes(name));
    expect({ missing, unlisted }).toEqual({ missing: [], unlisted: [] });
  });
});

describe("every setup file", () => {
  it("names only Gateway settings in secret set and secret unset", () => {
    const problems: string[] = [];
    for (const file of allFiles) {
      for (const call of secretCalls(file.text)) {
        for (const name of call.names) {
          if (isPlaceholder(name) || settable.has(name)) continue;
          problems.push(`${file.name}:${call.line} secret ${call.action} ${name}: not a settable Gateway setting`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("runs only commands the CLI has", () => {
    const paths = new Set(commandPaths());
    const groups = new Set([...paths].filter((route) => route.includes(" ")).map((route) => route.split(" ")[0]!));
    const problems: string[] = [];
    for (const file of allFiles) {
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

  it("never asks for a value through the chat, or puts one on a command line", () => {
    const problems: string[] = [];
    for (const file of allFiles) {
      file.text.split("\n").forEach((line, index) => {
        const lower = line.toLowerCase();
        for (const phrase of FORBIDDEN_PHRASES) {
          if (lower.includes(phrase)) problems.push(`${file.name}:${index + 1} says "${phrase}"`);
        }
        const value = valueAfterSecretSet(line);
        if (value) problems.push(`${file.name}:${index + 1} secret set with a value on the command line: ${value}`);
      });
    }
    expect(problems).toEqual([]);
  });

  it("has every section the README's contract requires", () => {
    const problems: string[] = [];
    for (const file of files) {
      const headings = [...file.text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((match) => match[1]!.toLowerCase());
      for (const required of REQUIRED_HEADINGS) {
        if (!headings.some((heading) => heading.startsWith(required.toLowerCase()))) {
          problems.push(`${file.name}: no "${required}" heading`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
