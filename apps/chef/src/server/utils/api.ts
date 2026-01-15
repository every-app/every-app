import {
  authenticateRequest,
  getAuthConfig,
} from "@every-app/sdk/tanstack/server";

/**
 * Standard JSON error response
 */
export function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Standard JSON success response
 */
export function jsonResponse<T>(data: T, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface AuthenticatedContext {
  request: Request;
  userId: string;
}

type AuthenticatedHandler = (ctx: AuthenticatedContext) => Promise<Response>;

/**
 * Wraps an API handler with authentication.
 * Automatically handles authentication and returns 401 if not authenticated.
 */
export function withAuth(handler: AuthenticatedHandler) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const authConfig = getAuthConfig();
    const session = await authenticateRequest(authConfig, request);

    if (!session || !session.sub) {
      return errorResponse("Unauthorized", 401);
    }

    return handler({ request, userId: session.sub });
  };
}
