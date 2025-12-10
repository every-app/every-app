import { createFileRoute } from "@tanstack/react-router";
import { getPublicJWKS } from "../../../server/jwt-utils";

export const Route = createFileRoute("/api/embedded/jwks")({
  server: {
    handlers: {
      GET: async () => {
        const jwks = await getPublicJWKS();
        return new Response(JSON.stringify(jwks), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
