import { createFileRoute } from "@tanstack/react-router";
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

export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/") ?? [];
    const data = await getDocsPage({ data: slugs });
    await clientMdxLoader.preload(data.path);
    return data;
  },
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
  const data = Route.useLoaderData();
  const Content = clientMdxLoader.getComponent(data.path);

  return (
    <DocsLayout {...baseOptions()} tree={data.pageTree as any}>
      <Suspense>
        <Content className="" />
      </Suspense>
    </DocsLayout>
  );
}
