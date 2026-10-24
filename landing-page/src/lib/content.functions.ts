import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  agentSource,
  blogSource,
  getAgentPageMarkdownUrl,
  getPageMarkdownUrl,
  source,
} from "@/lib/source";

export const getDocsPage = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      markdownUrl: getPageMarkdownUrl(page.slugs),
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  });

export const getAgentPage = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = agentSource.getPage(slugs);
    if (!page) throw notFound();

    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      markdownUrl: getAgentPageMarkdownUrl(page.slugs),
      pageTree: await agentSource.serializePageTree(agentSource.getPageTree()),
    };
  });

export const getBlogPost = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = blogSource.getPage(slugs);
    if (!page) throw notFound();

    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      url: page.url,
    };
  });

export const getBlogPosts = createServerFn({ method: "GET" }).handler(
  async () => {
    const pages = blogSource.getPages();
    return pages.map((page) => ({
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      slugs: page.slugs,
    }));
  },
);
