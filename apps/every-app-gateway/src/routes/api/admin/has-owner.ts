import { createFileRoute } from "@tanstack/react-router";
import { AdminService } from "@/server/services/AdminService";

export const Route = createFileRoute("/api/admin/has-owner")({
  server: {
    handlers: {
      GET: async () => {
        const result = await AdminService.hasOwner();
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
