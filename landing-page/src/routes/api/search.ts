import { createFileRoute } from "@tanstack/react-router";
import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

const server = createFromSource(source, {
  language: "english",
});

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      // TEMPORARY: docs search isn't public yet. Restore
      // `({ request }) => server.GET(request)` to re-enable.
      GET: async ({ request }) =>
        Response.redirect(new URL("/", request.url), 302),
    },
  },
});
