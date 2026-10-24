/**
 * The agent docs (landing-page/content/agent, served at everyapp.com/docs/agent
 * and in llms.txt): the pages coding agents read and answer from. The tests
 * beside this file keep them in step with the code: a generated page is
 * rewritten from the source, and a hand-written one must name every code,
 * field, flag or constant the source defines. When a test fails, regenerate
 * and then document what is new:
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

/** The `###` headings of a page, as written. */
export function h3s(page: string): string[] {
  return [...page.matchAll(/^### (.+)$/gm)].map((match) => match[1]!.trim());
}

/** GitHub-style anchor of a heading, as the docs site makes it. */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** ANSI colors out of a help text. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
