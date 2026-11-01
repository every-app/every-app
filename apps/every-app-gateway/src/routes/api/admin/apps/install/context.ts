import { createFileRoute } from "@tanstack/react-router";
import { serveInstallContext } from "@/server/deploy/install";

export const Route = createFileRoute("/api/admin/apps/install/context")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => serveInstallContext(request),
    },
  },
});
