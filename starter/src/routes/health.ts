import { createFileRoute } from "@tanstack/react-router";
import { getEveryAppUser } from "@every-app/sdk/server";
import { env } from "cloudflare:workers";

// Listed under `public` in everyapp.config.ts, so the Gateway lets anyone
// reach it. A signed-in member still arrives as `user`; anyone else is null.
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
