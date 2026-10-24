import { createFileRoute } from "@tanstack/react-router";
import { decodeMarkdownSegments, docsLlms, source } from "@/lib/source";

export const Route = createFileRoute("/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const page = source.getPage(
          decodeMarkdownSegments(params._splat?.split("/") ?? []),
        );
        if (!page) return new Response("Not found", { status: 404 });

        return new Response(await docsLlms.page(page), {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
