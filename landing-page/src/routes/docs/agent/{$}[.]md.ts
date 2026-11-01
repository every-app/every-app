import { createFileRoute } from "@tanstack/react-router";
import { agentLlms } from "@/lib/llms";
import { agentSource, decodeMarkdownSegments } from "@/lib/source";

export const Route = createFileRoute("/docs/agent/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const page = agentSource.getPage(
          decodeMarkdownSegments(params._splat?.split("/") ?? []),
        );
        if (!page) return new Response("Not found", { status: 404 });

        return new Response(await agentLlms.page(page), {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
