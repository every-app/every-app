import { auth } from "@/auth";
import {
  hasDisallowedNativeOrigin,
  normalizeExpoOrigin,
} from "@/auth/expo-origin-normalizer";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return auth.handler(normalizeExpoOrigin(request));
      },
      POST: async ({ request }: { request: Request }) => {
        // Only POST: Better Auth skips origin checks on safe methods, and GET
        // navigations can carry app-scheme referers (e.g. android-app://).
        if (hasDisallowedNativeOrigin(request)) {
          return new Response(JSON.stringify({ error: "Origin not allowed" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        return auth.handler(normalizeExpoOrigin(request));
      },
    },
  },
});
