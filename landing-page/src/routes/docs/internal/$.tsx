import { createFileRoute } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { Suspense } from "react";
import { DocsArticle } from "@/components/docs-article";
import { getInternalPage } from "@/lib/content.functions";
import { baseOptions } from "@/lib/layout.shared";
import { buildPageSeo } from "@/lib/seo";
import { internal } from "@/lib/source";

// Internal docs are public but unlisted: not in the user docs' sidebar,
// search, llms.txt or sitemap, and marked noindex.
export const Route = createFileRoute("/docs/internal/$")({
  loader: async ({ params }) => {
    const splat = params._splat?.replace(/\/+$/, "") ?? "";
    const slugs = splat ? splat.split("/") : [];
    const data = await getInternalPage({ data: slugs });
    await internal.getPage(data.path)?.preload();
    return data;
  },
  head: ({ loaderData }) =>
    buildPageSeo({
      title: loaderData?.title ?? "Internal docs",
      description: loaderData?.description,
      path: loaderData?.url ?? "/docs/internal",
      titleSuffix: "Every App Internal Docs",
      ogType: "article",
      noindex: true,
    }),
  component: Page,
});

function Page() {
  const { path, pageTree } = useFumadocsLoader(Route.useLoaderData());
  const entry = internal.getPage(path);
  if (!entry) throw new Error(`Unknown internal docs page: ${path}`);

  return (
    <DocsLayout
      {...baseOptions()}
      tree={pageTree}
      searchToggle={{ enabled: false }}
    >
      <Suspense>
        <DocsArticle entry={entry} />
      </Suspense>
    </DocsLayout>
  );
}
