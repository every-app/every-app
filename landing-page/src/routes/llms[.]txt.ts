import { createFileRoute } from "@tanstack/react-router";
import { docsLlms } from "@/lib/source";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(await docsLlms.index(), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
