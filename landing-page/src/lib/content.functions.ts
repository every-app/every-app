import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  agentSource,
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
