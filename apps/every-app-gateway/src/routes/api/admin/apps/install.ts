import { createFileRoute } from "@tanstack/react-router";
import {
  serveInstall,
  serveInstallAvailability,
} from "@/server/deploy/install";

/** Gateway app install from a public repository or oss.new release. */
export const Route = createFileRoute("/api/admin/apps/install")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        serveInstallAvailability(request),
      POST: ({ request }: { request: Request }) => serveInstall(request),
    },
  },
});
