import { createFileRoute } from "@tanstack/react-router";
import {
  serveInstall,
  serveInstallAvailability,
} from "@/server/deploy/install";

/** Install an app from GitHub (server/deploy/install.ts). */
export const Route = createFileRoute("/api/admin/apps/install")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        serveInstallAvailability(request),
      POST: ({ request }: { request: Request }) => serveInstall(request),
    },
  },
});
