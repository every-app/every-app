/**
 * The agent docs (landing-page/content/agent, served at everyapp.com/docs/agent
 * and in llms.txt): the pages coding agents read and answer from, and what
 * the docs tests beside this file read them with. To rewrite what is
 * generated:
 *
 *   pnpm -C packages/cli docs:update
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AGENT_DOCS_DIR = new URL(
  "../../../../landing-page/content/agent/",
  import.meta.url,
);

/** `pnpm -C packages/cli docs:update`: rewrite what is generated instead of comparing. */
export const UPDATE_DOCS = Boolean(process.env["UPDATE_DOCS"]);

function pagePath(slug: string): string {
  return fileURLToPath(new URL(`${slug}.md`, AGENT_DOCS_DIR));
}

export function readPage(slug: string): string {
  const path = pagePath(slug);
  if (!existsSync(path)) {
    throw new Error(
      `The agent docs page ${slug}.md is missing (${path}); every page the tests check must exist.`,
    );
  }
  return readFileSync(path, "utf8");
}

export function writePage(slug: string, content: string): void {
  writeFileSync(pagePath(slug), content);
}

/**
 * The text inside backticks, anywhere in the page, each once (a quoted value
 * counts without its quotes too). A span opened by a run of backticks closes
 * at the next run of the same length, as in CommonMark, so ``a `b` c`` is one
 * span and the spans after it on the line are still read as written.
 */
export function backticked(page: string): Set<string> {
  const found = new Set<string>();
  for (const match of page.matchAll(/(`+)([^\n]+?)\1(?!`)/g)) {
    const text = match[2]!;
    found.add(text);
    const quoted = text.match(/^(["'])(.+)\1$/);
    if (quoted) found.add(quoted[2]!);
  }
  return found;
}

/** GitHub-style anchor of a heading's text, as the docs site makes it (github-slugger). */
function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/ /g, "-");
}

/**
 * The anchors of a Markdown page's headings outside code, as the site makes
 * them: a heading's own `[#id]`, or its text without code, emphasis and link
 * markers, slugged, with `-1`, `-2` on a repeat.
 */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    const heading = line.match(/^#{1,6}[ \t]+(.*?)[ \t]*$/);
    if (!heading) continue;
    const custom = heading[1]!.match(/\[#([^\]]+)\]\s*$/);
    if (custom) {
      anchors.add(custom[1]!.toLowerCase());
      continue;
    }
    const text = heading[1]!
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(`+)(.*?)\1/g, "$2")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/\\(.)/g, "$1");
    const base = anchorOf(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** ANSI colors out of a help text. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * The documents the landing page mirrors from the repository at build time
 * (landing-page/scripts/sync-agent-docs.js), page slug under repo/ →
 * repository path.
 */
export function mirroredDocuments(): Map<string, string> {
  const script = readFileSync(
    fileURLToPath(new URL("../../scripts/sync-agent-docs.js", AGENT_DOCS_DIR)),
    "utf8",
  );
  const map = new Map<string, string>();
  for (const match of script.matchAll(/from: "([^"]+)",(?:(?!from:)[\s\S])*?to: "([^"]+)"/g)) {
    map.set(match[2]!, match[1]!);
  }
  return map;
}

/**
 * Commands the documents name before this branch's CLI answers them: the
 * provider registry's `everyapp provider add|show|remove`
 * (docs/design/2026-10-provider-registry.md section 8), built on the CLI
 * half of the same pull request while the docs half was written. A route
 * here passes the route checks of repoDocs.test.ts and
 * lib/app/setupSkills.test.ts while the CLI lacks it; once the CLI answers
 * it, repoDocs.test.ts fails until it is removed from here, so the list
 * never outlives the commands it waits for.
 */
export const PENDING_ROUTES: ReadonlyMap<string, string> = new Map([]);
