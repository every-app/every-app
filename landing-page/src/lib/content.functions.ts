import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { agentPageBody, readAgentMarkdown } from "@/lib/agent-docs";
import { renderAgentPage } from "@/lib/agent-markdown";
import {
  agentSource,
  blogSource,
  getAgentPageMarkdownUrl,
  getPageMarkdownUrl,
  isBlogPostVisible,
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
      metaTitle: page.data.metaTitle,
      metaDescription: page.data.metaDescription,
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
    const { html, toc } = renderAgentPage(
      agentPageBody(await readAgentMarkdown(page.path)),
    );

    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      metaTitle: page.data.metaTitle,
      metaDescription: page.data.metaDescription,
      url: page.url,
      markdownUrl: getAgentPageMarkdownUrl(page.slugs),
      pageTree: await agentSource.serializePageTree(agentSource.getPageTree()),
      html,
      toc,
    };
  });

export const getBlogPost = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = blogSource.getPage(slugs);
    if (!page || !isBlogPostVisible(page.data)) throw notFound();

    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      metaTitle: page.data.metaTitle,
      metaDescription: page.data.metaDescription,
      author: page.data.author,
      date: page.data.date,
      draft: page.data.draft ?? false,
      url: page.url,
    };
  });

/** Every visible post, newest first. */
export const getBlogPosts = createServerFn({ method: "GET" }).handler(
  async () =>
    blogSource
      .getPages()
      .filter((page) => isBlogPostVisible(page.data))
      .map((page) => ({
        title: page.data.title,
        description: page.data.description,
        date: page.data.date,
        draft: page.data.draft ?? false,
        url: page.url,
        slugs: page.slugs,
      }))
      .sort((a, b) => b.date.localeCompare(a.date)),
);
