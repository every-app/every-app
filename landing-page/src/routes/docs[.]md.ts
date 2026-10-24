import { createFileRoute } from "@tanstack/react-router";
import { docsLlms, source } from "@/lib/source";

// `/docs.md`: the docs home as Markdown (also `/docs/index.md`), so every
// page is at its URL plus `.md`, as llms.txt says.
export const Route = createFileRoute("/docs.md")({
  server: {
    handlers: {
      GET: async () => {
        const page = source.getPage([]);
        if (!page) return new Response("Not found", { status: 404 });
        return new Response(await docsLlms.page(page), {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
