import { createFileRoute, redirect } from "@tanstack/react-router";
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

// Pages from the docs before the October 2026 rewrite, by their old slug.
const movedPages: Record<string, string> = {
  "getting-started/quickstart": "quickstart",
  "build-an-app/create-app": "build-your-own-app",
  "build-an-app/start-from-template": "build-your-own-app",
  "build-an-app/local-dev": "apps",
  "how-it-works/overview": "introduction",
  "how-it-works/gateway": "gateway",
  "how-it-works/security": "architecture",
  "how-it-works/sdk": "apps",
  "reference/cli": "cli",
  "reference/manage-your-gateway": "gateway",
  "reference/cloudflare-access": "gateway",
  "architecture/cli-deployment": "architecture",
  "architecture/gateway-files": "architecture",
  "architecture/security-boundary": "architecture",
  "architecture/user-experience": "architecture",
  "learn-more": "introduction",
  "embedded-sdk/overview": "apps",
};

export const Route = createFileRoute("/docs/$")({
  loader: async ({ params }: { params: { _splat?: string } }) => {
    const splat = params._splat?.replace(/\/+$/, "") ?? "";
    const moved = movedPages[splat];
    if (moved) {
      throw redirect({
        to: "/docs/$",
        params: { _splat: moved },
        statusCode: 301,
      });
    }
    const slugs = splat ? splat.split("/") : [];
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
