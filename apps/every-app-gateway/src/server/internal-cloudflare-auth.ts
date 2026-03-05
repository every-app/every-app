import { createMiddleware } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

type CloudflareApiResponse<T> = {
  success: boolean;
  result: T;
};

type CloudflareD1Database = {
  uuid?: string;
  name?: string;
};

const GATEWAY_RESOURCE_NAME = "every-app-gateway";
const d1WriteProbeSql =
  "CREATE TABLE IF NOT EXISTS __every_app_internal_auth_probe (id INTEGER); DROP TABLE IF EXISTS __every_app_internal_auth_probe";

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

async function verifyGatewayWorkerReadAccess(
  token: string,
  accountId: string,
): Promise<boolean> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${GATEWAY_RESOURCE_NAME}/settings`,
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

  const data = (await response.json()) as CloudflareApiResponse<unknown>;
  return Boolean(data.success);
}

async function findGatewayD1DatabaseId(
  token: string,
  accountId: string,
): Promise<string | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(GATEWAY_RESOURCE_NAME)}&per_page=100`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as CloudflareApiResponse<
    CloudflareD1Database[]
  >;
  if (!data.success || !Array.isArray(data.result)) {
    return null;
  }

  const exactMatch = data.result.find(
    (database) => database.name === GATEWAY_RESOURCE_NAME,
  );
  const candidate = exactMatch;
  if (!candidate || typeof candidate.uuid !== "string") {
    return null;
  }

  return candidate.uuid;
}

async function verifyGatewayD1WriteAccess(
  token: string,
  accountId: string,
): Promise<boolean> {
  const databaseId = await findGatewayD1DatabaseId(token, accountId);
  if (!databaseId) {
    return false;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: d1WriteProbeSql }),
    },
  );

  if (!response.ok) {
    return false;
  }

  const data = (await response.json()) as CloudflareApiResponse<unknown>;
  return Boolean(data.success);
}

export async function requireInternalCloudflareAuth(
  request: Request,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error:
            "Gateway account ID is not configured. Redeploy the gateway with the latest CLI.",
        },
        503,
      ),
    };
  }

  const cloudflareToken = extractBearerToken(request);
  if (!cloudflareToken) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "Missing or invalid Cloudflare bearer token",
        },
        401,
      ),
    };
  }

  try {
    const [hasWorkerReadAccess, hasD1WriteAccess] = await Promise.all([
      verifyGatewayWorkerReadAccess(cloudflareToken, accountId),
      verifyGatewayD1WriteAccess(cloudflareToken, accountId),
    ]);

    const hasAccountAccess = hasWorkerReadAccess && hasD1WriteAccess;

    if (!hasAccountAccess) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error:
              "Cloudflare token is not authorized for internal gateway APIs",
          },
          401,
        ),
      };
    }
  } catch (error) {
    console.error("Failed to verify Cloudflare token:", error);
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "Failed to verify Cloudflare credentials",
        },
        502,
      ),
    };
  }

  return { ok: true };
}

export const internalCloudflareAuthMiddleware = createMiddleware().server(
  async ({ request, next }) => {
    const auth = await requireInternalCloudflareAuth(request);
    if (!auth.ok) {
      return auth.response;
    }

    return next();
  },
);
