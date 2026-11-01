import { createFileRoute, Link } from "@tanstack/react-router";
import { DocsBody } from "fumadocs-ui/layouts/docs/page";
import { Suspense, use } from "react";
import { BlogLayout, DraftBadge, PostDate } from "@/components/blog-layout";
import { mdxComponents } from "@/components/mdx";
import { getBlogPost } from "@/lib/content.functions";
import { buildPageSeo } from "@/lib/seo";
import { blog } from "@/lib/source";

export const Route = createFileRoute("/blogs/$")({
  loader: async ({ params }) => {
    const slugs = params._splat?.replace(/\/+$/, "").split("/") ?? [];
    const data = await getBlogPost({ data: slugs });
    await blog.getPage(data.path)?.preload();
    return data;
  },
  head: ({ loaderData }) =>
    buildPageSeo({
      title: loaderData?.metaTitle ?? loaderData?.title ?? "EveryApp Blog",
      description: loaderData?.metaDescription ?? loaderData?.description,
      path: loaderData?.url ?? "/blogs",
      titleSuffix: "EveryApp Blog",
      ogType: "article",
      noindex: loaderData?.draft,
    }),
  component: BlogPost,
});

// Keyed by the `author` name in a post's frontmatter.
const authorXUrls = new Map([["Ben Senescu", "https://x.com/bensenescu"]]);

function BlogPost() {
  const data = Route.useLoaderData();
  const entry = blog.getPage(data.path);
  if (!entry) throw new Error(`Unknown blog post: ${data.path}`);
  const authorUrl = authorXUrls.get(data.author);

  return (
    <BlogLayout>
      <article className="mx-auto max-w-3xl px-6 py-12 md:py-20">
        <header className="mb-10 border-b border-white/[0.08] pb-8">
          <Link
            to="/blogs"
            className="text-sm font-medium text-stone-400 transition-colors hover:text-white"
          >
            <span aria-hidden="true">&larr;</span> Back to Blog
          </Link>
          <h1 className="mt-6 mb-5 text-4xl font-semibold leading-tight tracking-tight text-white md:text-5xl">
            {data.title}
          </h1>
          {data.description && (
            <p className="max-w-2xl text-lg leading-8 text-stone-400">
              {data.description}
            </p>
          )}
          <p className="mt-6 flex items-center gap-2 text-sm text-stone-400">
            <span>
              By{" "}
              {authorUrl ? (
                <a
                  href={authorUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-stone-100 underline decoration-stone-600 underline-offset-4"
                >
                  {data.author}
                </a>
              ) : (
                <span className="font-medium text-stone-100">
                  {data.author}
                </span>
              )}
            </span>
            <span aria-hidden="true">·</span>
            <PostDate date={data.date} />
            {data.draft && <DraftBadge />}
          </p>
        </header>
        <Suspense>
          <PostBody entry={entry} />
        </Suspense>
      </article>
    </BlogLayout>
  );
}

function PostBody({
  entry,
}: {
  entry: NonNullable<ReturnType<typeof blog.getPage>>;
}) {
  use(entry.load());
  const MDX = entry.body;
  return (
    <DocsBody>
      <MDX components={mdxComponents} />
    </DocsBody>
  );
}
