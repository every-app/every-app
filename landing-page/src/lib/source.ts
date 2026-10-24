import { createGetUrl, llms, loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

/** Where the docs are served from, for the absolute URLs llms.txt gives agents. */
export const SITE_URL = "https://everyapp.com";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

// The agent docs: complete references coding agents read and answer from,
// served at /docs/agent, as Markdown at /docs/agent/<page>.md, and in
// llms.txt and llms-full.txt beside the user docs. content/agent/repo is
// mirrored from the repository's docs/ at build time (scripts/sync-agent-docs.js).
export const agent = defineDocs({
  dir: "content/agent",
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/docs",
});

export const agentSource = loader({
  source: agent.toFumadocsSource(),
  baseUrl: "/docs/agent",
});

/**
 * The processed Markdown keeps the MDX components the user guides use as
 * tags. An agent reads Markdown: the step wrappers go, and a callout becomes
 * a blockquote.
 */
export function plainMarkdown(markdown: string): string {
  return markdown
    .replace(/^<\/?Steps?>[ \t]*\n?/gm, "")
    .replace(
      /<Callout(?:\s+type="(\w+)")?>\n?([\s\S]*?)\n?<\/Callout>/g,
      (_, type: string | undefined, body: string) => {
        const label = type === "warn" || type === "error" ? "Warning" : "Note";
        const paragraphs = body
          .split(/\n\s*\n/)
          .map((paragraph) =>
            paragraph
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .join(" "),
          )
          .filter(Boolean);
        return `> **${label}:** ${paragraphs.join("\n>\n> ")}`;
      },
    )
    .replace(/\n{3,}/g, "\n\n");
}

/** A page as llms-full.txt and the `.md` routes serve it: its title, URL and processed Markdown. */
const renderPage = async (page: {
  url: string;
  data: { title: string; getText(type: "processed"): Promise<string> };
}) =>
  `# ${page.data.title} (${SITE_URL}${page.url})\n\n${plainMarkdown(await page.data.getText("processed"))}`;

export const docsLlms = llms(source, { renderPage });
export const agentLlms = llms(agentSource, { renderPage });

const getDocsUrl = createGetUrl("/docs");
const getAgentUrl = createGetUrl("/docs/agent");

/** The URL serving a docs page as Markdown: `/docs/gateway.md`, `/docs/index.md`. */
export function getPageMarkdownUrl(slugs: string[]): string {
  return getDocsUrl(markdownSegments(slugs));
}

/** The URL serving an agent docs page as Markdown: `/docs/agent/manifest.md`. */
export function getAgentPageMarkdownUrl(slugs: string[]): string {
  return getAgentUrl(markdownSegments(slugs));
}

function markdownSegments(slugs: string[]): string[] {
  const segments = slugs.length === 0 ? ["index"] : [...slugs];
  segments[segments.length - 1] += ".md";
  return segments;
}

/** The page slugs a Markdown URL's segments name. */
export function decodeMarkdownSegments(segments: string[]): string[] {
  const slugs = [...segments];
  slugs[slugs.length - 1] = slugs[slugs.length - 1].replace(/\.md$/, "");
  return slugs.length === 1 && slugs[0] === "index" ? [] : slugs;
}

/**
 * A fumadocs index (`# Title` and a list of relative links) as a section of
 * llms.txt with absolute links. The sidebar's own entries are left out: the
 * links between the two sets (a link with no description), a folder line
 * without a link, and a group left empty by that.
 */
function asSection(index: string, heading: string): string {
  const lines = index
    .replace(/^# .*\n/, `## ${heading}\n`)
    .replace(/\]\(\//g, `](${SITE_URL}/`)
    .split("\n")
    .filter(
      (line) =>
        !/^\s*- \[[^\]]+\]\([^)]+\)\s*$/.test(line) &&
        !/^\s*- (?!\[|\*\*)/.test(line),
    );
  const isEntry = (line: string) => /^\s*- \[/.test(line);
  const isGroup = (line: string) => /^\s*- \*\*.*\*\*\s*$/.test(line);
  return lines
    .filter((line, i) => {
      if (!isGroup(line)) return true;
      const next = lines.slice(i + 1).find((later) => later.trim() !== "");
      return next !== undefined && isEntry(next);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The page tree's URLs in sidebar order: a folder's index page, then its children. */
function urlsInOrder(node: {
  children?: unknown[];
  index?: unknown;
  url?: string;
}): string[] {
  const urls: string[] = [];
  if (node.index) urls.push(...urlsInOrder(node.index as typeof node));
  if (typeof node.url === "string") urls.push(node.url);
  for (const child of node.children ?? []) {
    urls.push(...urlsInOrder(child as typeof node));
  }
  return urls;
}

/** A source's pages in sidebar order (pages the tree doesn't place come last). */
function pagesInOrder<T extends { url: string }>(
  pages: T[],
  tree: Parameters<typeof urlsInOrder>[0],
): T[] {
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const ordered: T[] = [];
  for (const url of urlsInOrder(tree)) {
    const page = byUrl.get(url);
    if (page) {
      ordered.push(page);
      byUrl.delete(url);
    }
  }
  return [...ordered, ...byUrl.values()];
}

/**
 * `/llms.txt`: what an agent fetches first. Both worlds of documentation
 * with one line per page, and how to get any page as Markdown. The user
 * guides are short and for people; the agent docs are the complete
 * references an agent answers from.
 */
export async function llmsIndex(): Promise<string> {
  const [user, agentDocs] = await Promise.all([
    docsLlms.index(),
    agentLlms.index(),
  ]);
  return [
    "# Every App",
    "",
    "> Every App puts the web apps a person builds online, in their own Cloudflare account, behind one Gateway that handles sign-in, access and each app's database. Open source, alpha, moving fast.",
    "",
    'Two sets of pages. The user guides are short and written for the person; the agent docs are complete references written for a coding agent, which is how most people use these docs. Answer a person\'s "how do I" question from the agent docs, and send them to a user guide only for the steps they do themselves (Cloudflare account, domain, approving a login).',
    "",
    `Every page is served as Markdown at its URL with \`.md\` appended (for example ${SITE_URL}/docs/agent/manifest.md); fetch the page you need rather than everything. The user guides and the agent pages in one file: ${SITE_URL}/llms-full.txt (the documents mirrored from the repository under /docs/agent/repo are fetched one at a time). The command line tool is \`everyapp\`, run as \`pnpm everyapp\` from the Every App checkout; add \`--json\` when an agent drives it (${SITE_URL}/docs/agent/json.md).`,
    "",
    asSection(user, "User guides"),
    "",
    asSection(agentDocs, "Agent docs"),
    "",
  ].join("\n");
}

/**
 * `/llms-full.txt`: the user guides, then every agent docs page written
 * for agents, each set in its sidebar's order. The documents mirrored from
 * the repository (`repo/…`: the security model, the threat model, the
 * runbooks) are left out, since they run to megabytes and an agent fetches
 * the one it needs by its URL.
 */
export async function llmsFull(): Promise<string> {
  const user = await Promise.all(
    pagesInOrder(source.getPages(), source.getPageTree()).map((page) =>
      renderPage(page),
    ),
  );
  const pages = pagesInOrder(
    agentSource.getPages(),
    agentSource.getPageTree(),
  ).filter((page) => page.slugs[0] !== "repo");
  const agentDocs = await Promise.all(pages.map((page) => renderPage(page)));
  return `${[...user, ...agentDocs].join("\n\n")}\n`;
}
