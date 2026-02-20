import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { createClientLoader } from "fumadocs-mdx/runtime/vite";
import { DocsBody } from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { Suspense } from "react";
import { getBlogPost } from "@/lib/content.functions";
import { blog } from "../../../source.generated";

export const Route = createFileRoute("/blogs/$")({
  component: BlogPost,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/") ?? [];
    const data = await getBlogPost({ data: slugs });
    await clientMdxLoader.preload(data.path);
    return data;
  },
});

const clientMdxLoader = createClientLoader(blog, {
  id: "blog",
  component({ default: MDX }) {
    return (
      <DocsBody>
        <MDX
          components={{
            ...defaultMdxComponents,
          }}
        />
      </DocsBody>
    );
  },
});

function BlogPost() {
  const data = Route.useLoaderData();
  const Content = clientMdxLoader.getComponent(data.path);

  return (
    <HomeLayout {...baseOptions()}>
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
          <Content />
        </Suspense>
      </article>
    </HomeLayout>
  );
}
