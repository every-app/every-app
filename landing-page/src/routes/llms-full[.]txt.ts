import { createFileRoute } from "@tanstack/react-router";
import { llmsFull } from "@/lib/source";

export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(await llmsFull(), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
