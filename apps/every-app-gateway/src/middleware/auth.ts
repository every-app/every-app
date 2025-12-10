import { createAuth } from "@/auth";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export interface AuthContext {
  user: {
    id: string;
    email: string;
    name?: string;
    emailVerified: boolean;
    image?: string;
    createdAt: Date;
    updatedAt: Date;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    token: string;
    createdAt: Date;
    updatedAt: Date;
    ipAddress?: string;
    userAgent?: string;
  };
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
