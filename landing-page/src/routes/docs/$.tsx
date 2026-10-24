import { createFileRoute, redirect } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense } from "react";
import { DocsArticle } from "@/components/docs-article";
import { getDocsPage } from "@/lib/content.functions";
import { baseOptions } from "@/lib/layout.shared";
import { buildPageSeo } from "@/lib/seo";
import { docs } from "@/lib/source";

// Pages from earlier versions of the docs, by their old slug. "" is /docs.
const movedPages: Record<string, string> = {
  introduction: "",
  quickstart: "gateway",
  apps: "create-an-app",
  architecture: "how-it-works",
  "build-an-app": "create-an-app",
  "build-your-own-app": "create-an-app",
  "deploy-existing-apps": "create-an-app",
  cli: "commands",
  "getting-started/quickstart": "gateway",
  "build-an-app/create-app": "create-an-app",
  "build-an-app/start-from-template": "create-an-app",
  "build-an-app/local-dev": "create-an-app",
  "how-it-works/overview": "",
  "how-it-works/gateway": "gateway",
  "how-it-works/security": "how-it-works",
  "how-it-works/sdk": "how-it-works",
  "reference/cli": "commands",
  "reference/manage-your-gateway": "people",
  "reference/cloudflare-access": "access",
  "architecture/cli-deployment": "how-it-works",
  "architecture/gateway-files": "how-it-works",
  "architecture/security-boundary": "how-it-works",
  "architecture/user-experience": "how-it-works",
  "learn-more": "",
  "embedded-sdk/overview": "how-it-works",
};

export const Route = createFileRoute("/docs/$")({
  loader: async ({ params }) => {
    const splat = params._splat?.replace(/\/+$/, "") ?? "";
    const moved = movedPages[splat];
    if (moved !== undefined) {
      throw redirect({
        href: moved ? `/docs/${moved}` : "/docs",
        statusCode: 301,
      });
    }
    const slugs = splat ? splat.split("/") : [];
    const data = await getDocsPage({ data: slugs });
    await docs.getPage(data.path)?.preload();
    return data;
  },
  head: ({ loaderData }) =>
    buildPageSeo({
      title: loaderData?.title ?? "Every App Docs",
      description: loaderData?.description,
      path: loaderData?.url ?? "/docs",
      titleSuffix: "Every App Docs",
      ogType: "article",
    }),
  component: Page,
});

function Page() {
  const { path, pageTree, markdownUrl } = useFumadocsLoader(
    Route.useLoaderData(),
  );
  const entry = docs.getPage(path);
  if (!entry) throw new Error(`Unknown docs page: ${path}`);

  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
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
