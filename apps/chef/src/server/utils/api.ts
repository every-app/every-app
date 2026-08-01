import { requireEveryAppUser } from "@every-app/sdk/server";
import { env } from "cloudflare:workers";

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
    try {
      const user = await requireEveryAppUser(request, env);
      return handler({ request, userId: user.id });
    } catch (error) {
      if (error instanceof Response && error.status === 401) {
        return errorResponse("Unauthorized", 401);
      }
      throw error;
    }
  };
}
