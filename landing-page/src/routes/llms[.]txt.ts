import { createFileRoute } from "@tanstack/react-router";
import { source } from "@/lib/source";
import { getLLMText } from "@/lib/get-llm-text";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () => {
        const pages = source.getPages();
        const scan = pages.map(getLLMText);
        const scanned = await Promise.all(scan);
        const body = scanned.join("\n\n");

        return new Response(body, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        });
      },
    },
  },
});
