import { createFileRoute, Link } from "@tanstack/react-router";
import { BlogLayout, DraftBadge, PostDate } from "@/components/blog-layout";
import { getBlogPosts } from "@/lib/content.functions";
import { buildPageSeo } from "@/lib/seo";

export const Route = createFileRoute("/blogs/")({
  head: () =>
    buildPageSeo({
      title: "EveryApp Blog",
      description: "Posts from the team building EveryApp.",
      path: "/blogs",
    }),
  loader: async () => await getBlogPosts(),
  component: BlogIndex,
});

function BlogIndex() {
  const posts = Route.useLoaderData();

  return (
    <BlogLayout>
      <div className="mx-auto max-w-5xl px-6 py-16 md:py-24">
        <h1 className="text-4xl font-semibold tracking-tight text-white md:text-5xl">
          Blog
        </h1>

        {posts.length === 0 ? (
          <p className="mt-8 text-stone-400">No posts yet. Check back soon.</p>
        ) : (
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {posts.map((post) => (
              <article key={post.url}>
                <Link
                  to="/blogs/$"
                  params={{ _splat: post.slugs.join("/") }}
                  className="group block h-full rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 transition-colors hover:border-white/30"
                >
                  <div className="flex items-center gap-3 text-sm text-stone-500">
                    <PostDate date={post.date} />
                    {post.draft && <DraftBadge />}
                  </div>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                    {post.title}
                  </h2>
                  {post.description && (
                    <p className="mt-3 text-sm leading-6 text-stone-400">
                      {post.description}
                    </p>
                  )}
                  <p className="mt-5 text-sm font-medium text-stone-200">
                    Read post <span aria-hidden="true">&rarr;</span>
                  </p>
                </Link>
              </article>
            ))}
          </div>
        )}
      </div>
    </BlogLayout>
  );
}
