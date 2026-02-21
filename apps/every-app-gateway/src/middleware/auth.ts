import { createAuth, type Auth } from "@/auth";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { GatewayError } from "@/server/errors";

type UserRole = "owner" | "user" | "admin";

/**
 * Checks if a user has the owner role.
 * Used by ownerMiddleware to restrict access to owner-only endpoints.
 *
 * @param role - The user's role from their session
 * @returns true if the user is an owner
 */
function isOwner(role: string | undefined | null): boolean {
  return role === "owner";
}

/**
 * Checks if a user has one of the allowed roles.
 *
 * @param role - The user's role from their session
 * @param allowedRoles - Array of roles that are permitted
 * @returns true if the user's role is in the allowed list
 */
function hasRole(
  role: string | undefined | null,
  allowedRoles: UserRole[],
): boolean {
  if (!role) return false;
  return allowedRoles.includes(role as UserRole);
}

export interface AuthContext {
  user: Auth["$Infer"]["Session"]["user"];
  session: Auth["$Infer"]["Session"]["session"];
}

export const authMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const auth = createAuth();

  // Get the request object using TanStack Start's helper
  const request = getRequest();

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session || !session.user || !session.user.id) {
    throw new GatewayError(
      "UNAUTHORIZED",
      "Unauthorized - missing session, user, or user ID",
    );
  }

  return next({
    context: {
      user: session.user,
      session: session.session,
    } as AuthContext,
  });
});

/**
 * Middleware that requires the user to have the "owner" role.
 * Chains with authMiddleware to inherit the AuthContext type.
 */
export const ownerMiddleware = createMiddleware({
  type: "function",
})
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    if (!isOwner(context.user.role)) {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Unauthorized: Owner access required",
      );
    }

    return next();
  });
