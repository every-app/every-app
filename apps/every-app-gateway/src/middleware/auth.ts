import { createAuth, type Auth } from "@/auth";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

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
    throw new Error("Unauthorized - missing session, user, or user ID");
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
    if (context.user.role !== "owner") {
      throw new Error("Unauthorized: Owner access required");
    }

    return next();
  });
