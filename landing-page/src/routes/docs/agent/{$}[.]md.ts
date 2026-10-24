import { createFileRoute, notFound } from "@tanstack/react-router";
import { agentLlms, agentSource, decodeMarkdownSegments } from "@/lib/source";

export const Route = createFileRoute("/docs/agent/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const page = agentSource.getPage(
          decodeMarkdownSegments(params._splat?.split("/") ?? []),
        );
        if (!page) throw notFound();

        return new Response(await agentLlms.page(page), {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
