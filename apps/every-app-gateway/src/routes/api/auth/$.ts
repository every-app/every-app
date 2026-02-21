import { auth } from "@/auth";
import {
  isExpoDevModeEnabled,
  normalizeExpoOrigin,
} from "@/auth/expo-origin-normalizer";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

const isDevMode = isExpoDevModeEnabled({
  gatewayUrl: env.GATEWAY_URL,
  viteDev: import.meta.env.DEV,
});

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return auth.handler(normalizeExpoOrigin(request, { isDevMode }));
      },
      POST: async ({ request }: { request: Request }) => {
        return auth.handler(normalizeExpoOrigin(request, { isDevMode }));
      },
    },
  },
});
