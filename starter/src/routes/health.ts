import { createFileRoute } from "@tanstack/react-router";
import { getEveryAppUser } from "@every-app/sdk/server";
import { env } from "cloudflare:workers";

// A JSON endpoint without a page. Private, like every route not listed
// under `public` in everyapp.config.ts: the Gateway answers 401 to anyone it
// hasn't signed in, so `user` is the member who called (null only on a route
// made public). An uptime monitor reaches it with a personal access token.
export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const user = await getEveryAppUser(request, env);
        return Response.json({ ok: true, user: user?.email ?? null });
      },
    },
  },
});
