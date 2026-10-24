import { createFileRoute } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense } from "react";
import { DocsArticle } from "@/components/docs-article";
import { getAgentPage } from "@/lib/content.functions";
import { baseOptions } from "@/lib/layout.shared";
import { buildPageSeo } from "@/lib/seo";
import { agent } from "@/lib/source";

// The agent docs: public and indexable, with their own sidebar. A person
// lands here from the user docs' "Docs for your coding agent" link; an
// agent fetches the same pages as Markdown (`.md`, llms.txt).
export const Route = createFileRoute("/docs/agent/$")({
  loader: async ({ params }) => {
    const splat = params._splat?.replace(/\/+$/, "") ?? "";
    const slugs = splat ? splat.split("/") : [];
    const data = await getAgentPage({ data: slugs });
    await agent.getPage(data.path)?.preload();
    return data;
  },
  head: ({ loaderData }) =>
    buildPageSeo({
      title: loaderData?.title ?? "Docs for coding agents",
      description: loaderData?.description,
      path: loaderData?.url ?? "/docs/agent",
      titleSuffix: "Every App Agent Docs",
      ogType: "article",
    }),
  component: Page,
});

function Page() {
  const { path, pageTree, markdownUrl } = useFumadocsLoader(
    Route.useLoaderData(),
  );
  const entry = agent.getPage(path);
  if (!entry) throw new Error(`Unknown agent docs page: ${path}`);

  return (
    <DocsLayout
      {...baseOptions()}
      tree={pageTree}
      searchToggle={{ enabled: false }}
    >
      <Suspense>
        <DocsArticle
          entry={entry}
          actions={
            <div className="flex flex-row gap-2 items-center border-b -mt-4 pb-6">
              <MarkdownCopyButton markdownUrl={markdownUrl} />
              <ViewOptionsPopover markdownUrl={markdownUrl} />
            </div>
          }
        />
      </Suspense>
    </DocsLayout>
  );
}
