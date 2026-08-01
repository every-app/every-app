import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
} from "@/server/deploy-token-auth";

export const Route = createFileRoute("/api/deploy/identity-keys")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      GET: async () => {
        if (!env.JWT_PUBLIC_KEY) {
          return jsonResponse(
            { error: "Gateway has no JWT_PUBLIC_KEY configured" },
            500,
          );
        }
        return jsonResponse({
          issuer: env.GATEWAY_URL ?? null,
          keys: [env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n")],
        });
      },
    },
  },
});
