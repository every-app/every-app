import {
  createGetUrl,
  loader,
  type MetaData,
  type PageData,
  type VirtualFile,
} from "fumadocs-core/source";
import { pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";
import agentPages from "@/lib/agent-pages.generated.json";

/** Where the docs are served from, for the absolute URLs llms.txt gives agents. */
export const SITE_URL = "https://everyapp.com";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // metaTitle and metaDescription are what search results and link
    // previews show, when the page's own title or description is written
    // for the page (or for llms.txt) rather than for a results page.
    schema: pageSchema.extend({
      metaTitle: z.string().optional(),
      metaDescription: z.string().optional(),
    }),
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

// The agent docs: complete references coding agents read and answer from,
// served at /docs/agent, as Markdown at /docs/agent/<page>.md, and in
// llms.txt and llms-full.txt beside the user docs. They are plain Markdown
// and are not compiled: scripts/sync-agent-docs.js (before every dev and
// build) mirrors content/agent/repo from the repository's docs/, writes
// every page as the Markdown the site serves into public/docs/agent, and
// lists the pages and meta.json files in agent-pages.generated.json, which
// is all this source holds. The Worker reads a page's text through its
// ASSETS binding (src/lib/agent-docs.ts) when it needs it; llms.txt,
// llms-full.txt and the `.md` routes are src/lib/llms.ts.
type AgentPageData = PageData & {
  metaTitle?: string;
  metaDescription?: string;
};

export const agentSource = loader({
  source: {
    files: agentPages.files as VirtualFile<{
      pageData: AgentPageData;
      metaData: MetaData;
    }>[],
  },
  baseUrl: "/docs/agent",
});

// The blog: one Markdown file per post in content/blogs, served at
// /blogs/<file name>. `date` (YYYY-MM-DD) orders the index; `draft: true`
// keeps a post out of the index, the sitemap and the built site, and shows
// it only under `vite dev` (isBlogPostVisible).
export const blog = defineDocs({
  dir: "content/blogs",
  docs: {
    schema: pageSchema.extend({
      author: z.string(),
      date: z.iso.date(),
      draft: z.boolean().optional(),
      metaTitle: z.string().optional(),
      metaDescription: z.string().optional(),
    }),
    async: true,
  },
});

export const blogSource = loader({
  source: blog.toFumadocsSource(),
  baseUrl: "/blogs",
});

/** A draft post is served only by the dev server, never by a build. */
export function isBlogPostVisible(post: { draft?: boolean }): boolean {
  return !post.draft || import.meta.env.DEV;
}

const getDocsUrl = createGetUrl("/docs");
const getAgentUrl = createGetUrl("/docs/agent");

/** The URL serving a docs page as Markdown: `/docs/quickstart.md`, `/docs/index.md`. */
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
