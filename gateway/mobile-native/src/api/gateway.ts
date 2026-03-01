import { authClient, getGatewayUrl } from "@/src/lib/auth-client";
import { z } from "zod";
import type { AppConfig, SessionTokenResponse } from "@/src/types/gateway";

const appConfigSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  description: z.string(),
  appUrl: z.string(),
  devUrl: z.string().nullable(),
  isDefault: z.boolean().optional(),
  grantedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const userAppsResponseSchema = z.object({
  apps: z.array(appConfigSchema),
});

function getAuthHeaders(extraHeaders?: Record<string, string>) {
  const cookie = authClient.getCookie();
  return {
    "Content-Type": "application/json",
    ...(cookie ? { Cookie: cookie } : {}),
    ...extraHeaders,
  };
}

function isTrustedRequestOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "https:") {
      return true;
    }

    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

async function parseError(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: string;
      message?: string;
      code?: string;
    };

    if (data.error || data.message) {
      return (
        data.error ?? data.message ?? `Request failed (${response.status})`
      );
    }

    switch (data.code) {
      case "INVALID_INPUT":
        return "Invalid request";
      case "UNAUTHORIZED":
        return "Unauthorized";
      case "ORIGIN_NOT_ALLOWED":
        return "Origin not allowed for this app";
      case "REQUEST_EXPIRED":
      case "ACCESS_DENIED":
        return "Invalid request";
      case "INTERNAL_ERROR":
        return "Internal server error";
      default:
        return `Request failed (${response.status})`;
    }
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function fetchUserApps(): Promise<AppConfig[]> {
  const response = await fetch(`${getGatewayUrl()}/api/user-apps`, {
    method: "GET",
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  const result = userAppsResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Invalid response from /api/user-apps");
  }

  return result.data.apps;
}

export async function createSessionToken(
  appId: string | undefined,
  requestOrigin: string,
): Promise<SessionTokenResponse> {
  if (!isTrustedRequestOrigin(requestOrigin)) {
    throw new Error("Untrusted app origin");
  }

  const response = await fetch(`${getGatewayUrl()}/api/session-token`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      appId,
      requestOrigin,
      timestamp: Date.now(),
    }),
  });

  if (!response.ok) {
    throw new Error(await parseError(response));
  }

  return (await response.json()) as SessionTokenResponse;
}
