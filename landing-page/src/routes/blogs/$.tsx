import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { DocsBody } from "fumadocs-ui/layouts/docs/page";
import { homeOptions } from "@/lib/layout.shared";
import { Suspense } from "react";
import { mdxComponents } from "@/components/mdx";
import { getBlogPost } from "@/lib/content.functions";
import { blog } from "@/lib/source";
import { buildPageSeo } from "@/lib/seo";

export const Route = createFileRoute("/blogs/$")({
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/") ?? [];
    const data = await getBlogPost({ data: slugs });
    await blog.get(data.path)?.preload();
    return data;
  },
  head: ({ loaderData }) =>
    buildPageSeo({
      title: loaderData?.title ?? "Every App Blog",
      description: loaderData?.description,
      path: loaderData?.url ?? "/blogs",
      titleSuffix: "Every App Blog",
      ogType: "article",
    }),
  component: BlogPost,
});

function BlogPost() {
  const data = Route.useLoaderData();
  const entry = blog.get(data.path);
  if (!entry) throw new Error(`Unknown blog post: ${data.path}`);
  const MDX = entry.body;

  return (
    <HomeLayout {...homeOptions()}>
      <article className="max-w-3xl mx-auto px-6 py-12 md:py-24">
        <header className="mb-8">
          <h1 className="text-4xl font-bold mb-4">{data.title}</h1>
          {data.description && (
            <p className="text-lg text-fd-muted-foreground">
              {data.description}
            </p>
          )}
        </header>
        <Suspense>
          <DocsBody>
            <MDX components={mdxComponents} />
          </DocsBody>
        </Suspense>
      </article>
    </HomeLayout>
  );
}
