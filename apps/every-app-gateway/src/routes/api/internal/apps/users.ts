import { createFileRoute } from "@tanstack/react-router";
import { UserRepository } from "@/server/repositories/UserRepository";
import {
  jsonResponse,
  internalCloudflareAuthMiddleware,
} from "@/server/internal-cloudflare-auth";

export const Route = createFileRoute("/api/internal/apps/users")({
  server: {
    middleware: [internalCloudflareAuthMiddleware],
    handlers: {
      GET: async () => {
        const users = (await UserRepository.findAllForList()).map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        }));
        return jsonResponse({ users });
      },
    },
  },
});
