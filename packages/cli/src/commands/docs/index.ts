/**
 * `everyapp docs [page]`: a page of the agent docs as Markdown. The site
 * first (https://everyapp.com/docs/agent/<page>.md, the living copy), else
 * the pages this everyapp was built with: the checkout's
 * landing-page/content/agent, or the package's docs/agent, which
 * scripts/bundle-docs.mjs copies in at build. With no page, the list.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DOCS_URL } from "@/lib/app/settings";
import { findCheckoutRoot } from "@/lib/checkout";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import { cliVersion } from "@/lib/version";

interface DocsFlags {
  offline?: boolean;
  json?: boolean;
}

/** One bundled page: its slug (`setup/openrouter`), title and description. */
export interface BundledPage {
  page: string;
  title: string;
  description: string;
}

/** Where the bundled pages are, and how a page maps to its file. */
export interface DocsSource {
  /** A page's file, or null when there is none. */
  file(page: string): string | null;
  /** Every page, in slug order. */
  pages(): BundledPage[];
}

/** `https://everyapp.com/docs/agent/setup/openrouter.md#steps`, `/docs/agent/manifest`, `errors.md` → the slug. */
export function pageSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/^docs\/agent(?:\/|$)/, "")
    .replace(/\.md$/, "")
    .replace(/\/+$/, "")
    .replace(/(^|\/)index$/, "");
}

function frontmatter(text: string): { title?: string; description?: string; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const field = line.match(/^(\w+):\s*(.*)$/);
    if (!field) continue;
    const value = field[2]!.trim();
    fields[field[1]!] = /^".*"$/.test(value) ? (JSON.parse(value) as string) : value;
  }
  return { title: fields["title"], description: fields["description"], body: text.slice(match[0].length) };
}

/** The pages under `dir` (`<slug>.md`, a folder's `index.md` as the folder), the security page at `repo/threat-model`. */
export function directorySource(dir: string, securityPage: string | null): DocsSource {
  const fileOf = (page: string): string | null => {
    if (page === "repo/threat-model" && securityPage && fs.existsSync(securityPage)) return securityPage;
    for (const name of page === "" ? ["index.md"] : [`${page}.md`, `${page}/index.md`]) {
      const file = path.join(dir, name);
      if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) return null;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
    return null;
  };
  return {
    file: fileOf,
    pages: () => {
      const found: BundledPage[] = [];
      const walk = (sub: string) => {
        const at = path.join(dir, sub);
        if (!fs.existsSync(at)) return;
        for (const name of fs.readdirSync(at).sort()) {
          const rel = sub ? `${sub}/${name}` : name;
          if (fs.statSync(path.join(dir, rel)).isDirectory()) {
            if (name !== "repo" || !securityPage) walk(rel);
            continue;
          }
          if (!name.endsWith(".md")) continue;
          const { title, description } = frontmatter(fs.readFileSync(path.join(dir, rel), "utf8"));
          found.push({ page: pageSlug(rel), title: title ?? rel, description: description ?? "" });
        }
      };
      walk("");
      if (securityPage && fs.existsSync(securityPage)) {
        found.push({ page: "repo/threat-model", title: "Security", description: "Who is trusted with what, the boundaries and their invariants." });
      }
      return found;
    },
  };
}

/** The checkout's own pages, or the installed package's bundled copy. */
export function bundledSource(moduleUrl: string = import.meta.url): DocsSource {
  const root = findCheckoutRoot(moduleUrl);
  if (root) {
    return directorySource(path.join(root, "landing-page", "content", "agent"), path.join(root, "docs", "security.md"));
  }
  for (let dir = path.dirname(fileURLToPath(moduleUrl)); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return directorySource(path.join(dir, "docs", "agent"), null);
    }
  }
  return directorySource(path.join(process.cwd(), "node_modules", "everyapp", "docs", "agent"), null);
}

/** A page as the site serves it: its title and URL as a heading, then the page. */
function served(page: string, text: string): string {
  const { title, body } = frontmatter(text);
  const url = page ? `${AGENT_DOCS_URL}/${page}` : AGENT_DOCS_URL;
  return `# ${title ?? page} (${url})\n\n${body.trim()}\n`;
}

/** The site's copy of a page: its text, `null` when the site has no such page, `undefined` when it can't be reached. */
export type FetchPage = (url: string) => Promise<string | null | undefined>;

export const fetchPage: FetchPage = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "text/markdown" } });
    if (response.status === 404) return null;
    if (!response.ok) return undefined;
    const type = response.headers.get("content-type") ?? "";
    // A page that isn't Markdown (an error page, a captive portal) isn't the page.
    return type.includes("markdown") || type.includes("text/plain") ? await response.text() : undefined;
  } catch {
    return undefined;
  }
};

export async function docs(
  flags: DocsFlags,
  raw?: string,
  source: DocsSource = bundledSource(),
  fetcher: FetchPage = fetchPage,
): Promise<void> {
  await runCommand(flags, async (out) => {
    if (raw === undefined || raw.trim() === "") {
      const pages = source.pages();
      out.emit({
        type: "done",
        message: `${pages.length} agent docs pages`,
        display: [
          `The agent docs: ${AGENT_DOCS_URL} (every page with a line each: https://everyapp.com/llms.txt).`,
          `Print one with ${CLI} docs <page>.`,
          "",
          ...formatTable(["PAGE", "TITLE"], pages.map((entry) => [entry.page || "index", entry.title])),
        ].join("\n"),
        data: { url: AGENT_DOCS_URL, pages },
      });
      return;
    }
    const page = pageSlug(raw);
    const url = `${AGENT_DOCS_URL}/${page || "index"}.md`;
    const live = flags.offline ? undefined : await fetcher(url);
    if (typeof live === "string") {
      out.emit({ type: "done", message: url, display: live.trimEnd(), data: { page, url, source: "site", markdown: live } });
      return;
    }
    const file = source.file(page);
    if (!file) {
      throw new EveryAppError("DOCS_PAGE_NOT_FOUND", `There is no agent docs page "${page}"`, {
        fix: `${CLI} docs lists them all`,
        data: { page },
      });
    }
    const markdown = served(page, fs.readFileSync(file, "utf8"));
    const why = flags.offline ? "--offline" : live === null ? "the site has no such page" : "the site didn't answer";
    const note = `From the copy bundled with everyapp ${cliVersion} (${why}); ${url} is the living one.`;
    out.emit({
      type: "done",
      message: note,
      display: `${markdown.trimEnd()}\n\n> ${note}`,
      data: { page, url, source: "bundled", version: cliVersion, markdown },
    });
  });
}
