import { createMiddleware } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { AppTokenService } from "@/server/services/AppTokenService";

const INTERNAL_APIS_DISABLED_ERROR_CODE = "INTERNAL_APIS_DISABLED";

type DeploymentMode = "self_hosted" | "hosted";

export type DeployTokenContext = {
  organizationId: string;
  scopes: string[];
};

function resolveDeploymentMode(
  rawMode: string | undefined,
): DeploymentMode | "invalid" {
  const normalized = rawMode?.trim().toLowerCase();
  if (!normalized) {
    return "invalid";
  }

  if (normalized === "self_hosted" || normalized === "hosted") {
    return normalized;
  }

  return "invalid";
}

export function jsonResponse(payload: unknown, status = 200): Response {
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

export async function requireDeployTokenAuth(
  request: Request,
): Promise<
  { ok: true; context: DeployTokenContext } | { ok: false; response: Response }
> {
  const deploymentMode = resolveDeploymentMode(env.GATEWAY_DEPLOYMENT_MODE);
  if (deploymentMode === "hosted" || deploymentMode === "invalid") {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "Deploy gateway APIs are disabled for this deployment mode.",
          code: INTERNAL_APIS_DISABLED_ERROR_CODE,
        },
        404,
      ),
    };
  }

  const deployToken = extractBearerToken(request);
  if (!deployToken) {
    return {
      ok: false,
      response: jsonResponse({ error: "Missing or invalid deploy token" }, 401),
    };
  }

  const verifiedToken = await AppTokenService.verifyDeployToken(deployToken);
  if (!verifiedToken) {
    return {
      ok: false,
      response: jsonResponse({ error: "Invalid or expired deploy token" }, 401),
    };
  }

  return {
    ok: true,
    context: verifiedToken,
  };
}

export const deployTokenAuthMiddleware = createMiddleware().server(
  async ({ request, next }) => {
    const auth = await requireDeployTokenAuth(request);
    if (!auth.ok) {
      return auth.response;
    }

    return next({ context: auth.context });
  },
);
