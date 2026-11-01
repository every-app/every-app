import { createFileRoute } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { getAgentPage } from "@/lib/content.functions";
import { baseOptions } from "@/lib/layout.shared";
import { buildPageSeo } from "@/lib/seo";

// The agent docs: public and indexable, with their own sidebar. A person
// lands here from the user docs' "Docs for your coding agent" link; an
// agent fetches the same pages as Markdown (`.md`, llms.txt). The page is
// plain Markdown rendered on the server (src/lib/agent-docs.ts), not MDX.
export const Route = createFileRoute("/docs/agent/$")({
  loader: async ({ params }) => {
    const splat = params._splat?.replace(/\/+$/, "") ?? "";
    const slugs = splat ? splat.split("/") : [];
    return getAgentPage({ data: slugs });
  },
  head: ({ loaderData }) =>
    buildPageSeo({
      title:
        loaderData?.metaTitle ?? loaderData?.title ?? "Docs for coding agents",
      description: loaderData?.metaDescription ?? loaderData?.description,
      path: loaderData?.url ?? "/docs/agent",
      titleSuffix: "EveryApp",
      ogType: "article",
    }),
  component: Page,
});

function Page() {
  const { pageTree, markdownUrl, title, description, html, toc } =
    useFumadocsLoader(Route.useLoaderData());

  return (
    <DocsLayout
      {...baseOptions()}
      tree={pageTree}
      searchToggle={{ enabled: false }}
    >
      <DocsPage toc={toc}>
        <DocsTitle>{title}</DocsTitle>
        <DocsDescription>{description}</DocsDescription>
        <div className="flex flex-row gap-2 items-center border-b -mt-4 pb-6">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover markdownUrl={markdownUrl} />
        </div>
        <DocsBody dangerouslySetInnerHTML={{ __html: html }} />
      </DocsPage>
    </DocsLayout>
  );
}
