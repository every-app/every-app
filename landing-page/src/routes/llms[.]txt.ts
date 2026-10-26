import { createFileRoute } from "@tanstack/react-router";
import { llmsIndex } from "@/lib/llms";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(await llmsIndex(), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
  },
});
