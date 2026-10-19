import { createFileRoute } from "@tanstack/react-router";
import type { PageTree } from "fumadocs-core/server";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { createClientLoader } from "fumadocs-mdx/runtime/vite";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { Suspense } from "react";
import { getInternalPage } from "@/lib/content.functions";
import { internal } from "../../../../source.generated";
import { buildPageSeo } from "@/lib/seo";

// Internal docs are public but unlisted: not in the user docs' sidebar,
// search, llms.txt or sitemap, and marked noindex.
export const Route = createFileRoute("/docs/internal/$")({
  loader: async ({ params }: { params: { _splat?: string } }) => {
    const splat = params._splat?.replace(/\/+$/, "") ?? "";
    const slugs = splat ? splat.split("/") : [];
    const data = await getInternalPage({ data: slugs });
    await clientMdxLoader.preload(data.path);
    return data;
  },
  head: ({ loaderData }: { loaderData?: unknown }) => {
    const data = loaderData as
      | { title?: string; description?: string; url?: string }
      | undefined;
    return buildPageSeo({
      title: data?.title ?? "Internal docs",
      description: data?.description,
      path: data?.url ?? "/docs/internal",
      titleSuffix: "Every App Internal Docs",
      ogType: "article",
      noindex: true,
    });
  },
  component: Page,
});

const clientMdxLoader = createClientLoader(internal.doc, {
  id: "internal",
  component(
    { toc, frontmatter, default: MDX },
    props: {
      className?: string;
    },
  ) {
    return (
      <DocsPage toc={toc} {...props}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <MDX
            components={{
              ...defaultMdxComponents,
            }}
          />
        </DocsBody>
      </DocsPage>
    );
  },
});

function Page() {
  const data = Route.useLoaderData() as {
    path: string;
    pageTree: unknown;
  };
  const Content = clientMdxLoader.getComponent(data.path);

  return (
    <DocsLayout
      {...baseOptions()}
      tree={data.pageTree as PageTree.Root}
      searchToggle={{ enabled: false }}
    >
      <Suspense>
        <Content className="" />
      </Suspense>
    </DocsLayout>
  );
}
