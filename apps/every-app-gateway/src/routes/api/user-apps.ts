import { createFileRoute } from "@tanstack/react-router";
import { getMyApps } from "@/serverFunctions/apps";
import { getGatewayErrorCode } from "@/server/errors";
import { jsonResponse } from "./_request-origin";

export const Route = createFileRoute("/api/user-apps")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const result = await getMyApps();
          return jsonResponse(result);
        } catch (error) {
          if (getGatewayErrorCode(error) === "UNAUTHORIZED") {
            return jsonResponse({ error: "Unauthorized" }, 401);
          }

          return jsonResponse({ error: "Internal server error" }, 500);
        }
      },
    },
  },
});
