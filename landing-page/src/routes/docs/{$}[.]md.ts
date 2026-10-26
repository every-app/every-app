import { createFileRoute } from "@tanstack/react-router";
import { agentLlms, docsLlms } from "@/lib/llms";
import { agentSource, decodeMarkdownSegments, source } from "@/lib/source";

export const Route = createFileRoute("/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugs = decodeMarkdownSegments(params._splat?.split("/") ?? []);
        // `/docs/agent.md` is the agent docs home, like `/docs/agent/index.md`.
        if (slugs.length === 1 && slugs[0] === "agent") {
          const home = agentSource.getPage([]);
          if (!home) return new Response("Not found", { status: 404 });
          return new Response(await agentLlms.page(home), {
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        }
        const page = source.getPage(slugs);
        if (!page) return new Response("Not found", { status: 404 });

        return new Response(await docsLlms.page(page), {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
