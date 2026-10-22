import { createGetUrl, llms, loader } from "fumadocs-core/source";
import { pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

// Notes for the people building Every App, served at /docs/internal. Kept out
// of the user docs' sidebar, search, llms.txt and sitemap.
export const internal = defineDocs({
  dir: "content/internal",
  docs: {
    async: true,
  },
});

export const blog = defineCollections({
  type: "doc",
  dir: "content/blog",
  async: true,
  schema: pageSchema.extend({
    author: z.string(),
    date: z.string(),
  }),
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/docs",
});

export const internalSource = loader({
  source: internal.toFumadocsSource(),
  baseUrl: "/docs/internal",
});

export const blogSource = loader({
  source: blog.toFumadocsSource(),
  baseUrl: "/blogs",
});

export const docsLlms = llms(source, {
  renderPage: async (page) =>
    `# ${page.data.title} (${page.url})\n\n${await page.data.getText("processed")}`,
});

const getDocsUrl = createGetUrl("/docs");

/** The URL serving a docs page as Markdown: `/docs/gateway.md`, `/docs/index.md`. */
export function getPageMarkdownUrl(slugs: string[]): string {
  const segments = slugs.length === 0 ? ["index"] : [...slugs];
  segments[segments.length - 1] += ".md";
  return getDocsUrl(segments);
}

/** The page slugs a Markdown URL's segments name. */
export function decodeMarkdownSegments(segments: string[]): string[] {
  const slugs = [...segments];
  slugs[slugs.length - 1] = slugs[slugs.length - 1].replace(/\.md$/, "");
  return slugs.length === 1 && slugs[0] === "index" ? [] : slugs;
}
