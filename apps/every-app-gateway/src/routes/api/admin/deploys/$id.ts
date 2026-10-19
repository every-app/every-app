import { createFileRoute } from "@tanstack/react-router";
import { serveInstallJob } from "@/server/deploy/install";

/** A deploy job, as Admin → Apps polls an install (server/deploy/install.ts). */
export const Route = createFileRoute("/api/admin/deploys/$id")({
  server: {
    handlers: {
      GET: ({
        request,
        params,
      }: {
        request: Request;
        params: { id: string };
      }) => serveInstallJob(request, params.id),
    },
  },
});
