import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";
import { MIN_CLI_VERSION, MIN_SDK_VERSION } from "@/server/deploy-api";

function gatewayHost(): string | null {
  try {
    return env.GATEWAY_URL ? new URL(env.GATEWAY_URL).host : null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/deploy/whoami")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      GET: async ({ context }) => {
        const { organizationId, scopes } = context as DeployTokenContext;
        const rows = await db
          .select({
            name: organizations.name,
          })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .limit(1);

        return jsonResponse({
          organizationId,
          organizationName: rows[0]?.name ?? organizationId,
          scopes,
          // App deploys run in the gateway's own Cloudflare account.
          accountId: env.CLOUDFLARE_ACCOUNT_ID ?? null,
          gateway: {
            release: env.EVERYAPP_RELEASE ?? null,
            gatewayHost: gatewayHost(),
          },
          minCli: MIN_CLI_VERSION,
          minSdk: MIN_SDK_VERSION,
          capabilities: {
            appGateway: true,
            // register → deployed → activate, with gateway-assigned names.
            deployProtocol: 2,
          },
        });
      },
    },
  },
});
