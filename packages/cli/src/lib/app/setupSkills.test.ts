/**
 * The setup files of the everyapp skill (skills/everyapp/setup/*.md) stay
 * honest about the CLI they describe: every file the index names exists
 * and every file is indexed; every `secret set NAME` names a Gateway
 * setting the CLI accepts (or, with `--app <id>`, an app's own secret);
 * every `pnpm everyapp …` is a route the CLI has;
 * no file asks for a value through the chat or puts one on a command
 * line; and each file has the sections the README's contract requires.
 * The end-to-end harness in test/setup-skills/ (not run here) drives
 * `claude -p` through the same files.
 */
import fs from "node:fs";
import path from "node:path";
import { isSettableGatewaySetting } from "@every-app/sdk/internal";
import { describe, expect, it } from "vitest";
import { commandPaths } from "@/app";
import { PENDING_ROUTES } from "@/docs/pages";
import { GENERATED_SETUP_MARKER } from "@/docs/providersCatalog";
import { checkoutRoot } from "@/lib/checkout";
import { asksForSecretInChat } from "../../../test/shared/chat-secret.mjs";

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

/** The sections every hand-written setup file has, in the README's contract. */
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

/** `NAME`, `<name>`, `NAME…`: a placeholder, not a setting. */
function isPlaceholder(token: string): boolean {
  return /^<.*>$/.test(token) || /^NAMES?(?:…|\.\.\.)?$/.test(token) || token.includes("…");
}

/**
 * Every `secret set|unset` in `text`, with the names given before any flag,
 * and whether `--app <id>` follows on the same command (then the names are
 * that app's own secrets, which the Gateway registry doesn't list).
 */
function secretCalls(text: string): Array<{ action: string; names: string[]; app: boolean; line: number }> {
  const calls: Array<{ action: string; names: string[]; app: boolean; line: number }> = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/(?:pnpm |npx )?everyapp secret (set|unset)((?:\s+(?:[A-Z][A-Z0-9_]*|<[^>]+>|NAMES?…?))*)/g)) {
      const names = match[2]!.trim().split(/\s+/).filter(Boolean);
      const rest = line.slice(match.index! + match[0].length).split(/[`|;)&]/)[0]!;
      calls.push({ action: match[1]!, names, app: /(?:^|\s)--app\b/.test(rest), line: index + 1 });
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
        if (!token.includes("=") && /^--(?:from-env|gateway|account-id|app)$/.test(token)) i++;
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
          // A fixed Gateway setting, or a remote MCP app's credential (any name ending in _MCP_TOKEN).
          if (isPlaceholder(name) || isSettableGatewaySetting(name) || call.app) continue;
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
          // A route the CLI half of the same pull request builds (docs/pages.ts says which, and repoDocs.test.ts fails once it is built).
          if (!paths.has(route) && !PENDING_ROUTES.has(route)) problems.push(`${file.name}:${index + 1} pnpm everyapp ${route}`);
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
        // The detector the claude -p harness flags an agent's turn with: a
        // sentence a setup file writes is one an agent may repeat.
        const ask = asksForSecretInChat(line);
        if (ask) problems.push(`${file.name}:${index + 1} asks "${ask}"`);
        const value = valueAfterSecretSet(line);
        if (value) problems.push(`${file.name}:${index + 1} secret set with a value on the command line: ${value}`);
      });
    }
    expect(problems).toEqual([]);
  });

  it("has every section the README's contract requires", () => {
    const problems: string[] = [];
    for (const file of files) {
      // setup/providers.md is generated from the catalog (docs/providersCatalog.ts): one section per
      // provider, each pointing at the provider's own file where there is one, so the nine sections of
      // a hand-written guide aren't its shape. agentDocs.test.ts holds it to the catalog instead.
      if (file.text.startsWith(GENERATED_SETUP_MARKER)) continue;
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
