import { createFileRoute } from "@tanstack/react-router";
import { AdminService } from "@/server/services/AdminService";

export const Route = createFileRoute("/api/admin/has-owner")({
  server: {
    handlers: {
      GET: async () => {
        // Intentionally unauthenticated: the CLI uses this endpoint during
        // bootstrap before any user session exists. Keep the response minimal
        // to avoid exposing account details.
        const result = await AdminService.hasOwner();
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
