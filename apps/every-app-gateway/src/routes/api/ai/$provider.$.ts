import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { handleAiProxyRequest } from "@/server/ai-proxy";
import { createAiGatewayAuthenticator } from "@/server/ai-gateway-auth";

const authenticate = createAiGatewayAuthenticator(env);

async function handleProxy({
  request,
  provider,
}: {
  request: Request;
  provider: string;
}): Promise<Response> {
  return handleAiProxyRequest({
    request,
    provider,
    env,
    authenticate,
  });
}

export const Route = createFileRoute("/api/ai/$provider/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        return handleProxy({ request, provider: params.provider });
      },
      POST: async ({ request, params }) => {
        return handleProxy({ request, provider: params.provider });
      },
      PUT: async ({ request, params }) => {
        return handleProxy({ request, provider: params.provider });
      },
      PATCH: async ({ request, params }) => {
        return handleProxy({ request, provider: params.provider });
      },
      DELETE: async ({ request, params }) => {
        return handleProxy({ request, provider: params.provider });
      },
    },
  },
});
