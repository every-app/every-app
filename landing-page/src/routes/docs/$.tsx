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
import { getDocsPage } from "@/lib/content.functions";
import { docs } from "../../../source.generated";
import { buildPageSeo } from "@/lib/seo";

export const Route = createFileRoute("/docs/$")({
  loader: async ({ params }: { params: { _splat?: string } }) => {
    const slugs = params._splat?.split("/") ?? [];
    const data = await getDocsPage({ data: slugs });
    await clientMdxLoader.preload(data.path);
    return data;
  },
  head: ({ loaderData }: { loaderData?: unknown }) => {
    const data = loaderData as
      | { title?: string; description?: string; url?: string }
      | undefined;
    const title = data?.title ?? "Every App Docs";
    const description = data?.description;
    return buildPageSeo({
      title,
      description,
      path: data?.url ?? "/docs",
      titleSuffix: "Every App Docs",
      ogType: "article",
    });
  },
  component: Page,
});

const clientMdxLoader = createClientLoader(docs.doc, {
  id: "docs",
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
    <DocsLayout {...baseOptions()} tree={data.pageTree as PageTree.Root}>
      <Suspense>
        <Content className="" />
      </Suspense>
    </DocsLayout>
  );
}
