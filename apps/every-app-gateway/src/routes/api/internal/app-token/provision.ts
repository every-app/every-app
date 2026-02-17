import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { env } from "cloudflare:workers";
import { AppRepository } from "@/server/repositories/AppRepository";
import { AppTokenService } from "@/server/services/AppTokenService";

const DEFAULT_TOKEN_SCOPES = ["provider:openai"];

const provisionAppTokenSchema = z.object({
  appSlug: z
    .string()
    .trim()
    .min(1, "appSlug is required")
    .max(128, "appSlug is too long")
    .regex(
      /^[a-z0-9-]+$/,
      "appSlug must contain only lowercase letters, numbers, and hyphens",
    ),
  scopes: z.array(z.string().min(1)).max(20).optional(),
});

type CloudflareApiResponse<T> = {
  success: boolean;
  result: T;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

async function verifyCloudflareAccountAccess(
  token: string,
  accountId: string,
): Promise<boolean> {
  // TODO: Replace this check with gateway OAuth authorization once the CLI
  // can authenticate directly with the gateway. At that point, only owner
  // sessions/tokens should be allowed to provision app credentials.
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    },
  );

  if (!response.ok) {
    return false;
  }

  const data = (await response.json()) as CloudflareApiResponse<{
    subdomain?: string;
  }>;
  return Boolean(data.success && data.result && data.result.subdomain);
}

export const Route = createFileRoute("/api/internal/app-token/provision")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
        if (!accountId) {
          return jsonResponse(
            {
              error:
                "Gateway account ID is not configured. Redeploy the gateway with the latest CLI.",
            },
            503,
          );
        }

        const cloudflareToken = extractBearerToken(request);
        if (!cloudflareToken) {
          return jsonResponse(
            {
              error: "Missing or invalid Cloudflare bearer token",
            },
            401,
          );
        }

        try {
          const hasAccountAccess = await verifyCloudflareAccountAccess(
            cloudflareToken,
            accountId,
          );
          if (!hasAccountAccess) {
            return jsonResponse(
              {
                error:
                  "Cloudflare token does not have access to this gateway account",
              },
              401,
            );
          }
        } catch (error) {
          console.error("Failed to verify Cloudflare token:", error);
          return jsonResponse(
            {
              error: "Failed to verify Cloudflare credentials",
            },
            502,
          );
        }

        let rawBody: unknown;
        try {
          rawBody = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON payload" }, 400);
        }

        const parsed = provisionAppTokenSchema.safeParse(rawBody);
        if (!parsed.success) {
          const firstIssue = parsed.error.issues[0];
          return jsonResponse(
            {
              error: firstIssue?.message || "Invalid request payload",
            },
            400,
          );
        }

        const app = await AppRepository.findByAppId(parsed.data.appSlug);
        if (!app) {
          return jsonResponse(
            {
              error: `App not found: ${parsed.data.appSlug}`,
            },
            404,
          );
        }

        try {
          // TODO: Replace this with a dedicated local-dev token issuance flow
          // that does not rely on Cloudflare API token auth.
          const token = await AppTokenService.create(
            {
              appId: app.id,
              scopes: parsed.data.scopes ?? DEFAULT_TOKEN_SCOPES,
              expiresAt: null,
            },
            null,
          );

          return jsonResponse({
            token: token.token,
            tokenPrefix: token.tokenPrefix,
            appId: token.appId,
            appSlug: token.appSlug,
            scopes: token.scopes,
          });
        } catch (error) {
          return jsonResponse(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to create token",
            },
            400,
          );
        }
      },
    },
  },
});
