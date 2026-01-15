import { createMiddleware } from "@tanstack/react-start";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  authenticateRequest,
  getAuthConfig,
} from "@every-app/sdk/tanstack/server";

export const ensureUserMiddleware = createMiddleware({
  type: "function",
}).server(async (c) => {
  const { next } = c;

  const authConfig = getAuthConfig();

  const session = await authenticateRequest(authConfig);

  if (!session) {
    console.error("No session found, returning 401");
    throw new Response("Unauthenticated", { status: 401 });
  }

  if (!session.email) {
    throw new Error("Email should always be on our session tokens.");
  }

  const userId = session.sub;

  // Check if user exists
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!user) {
    try {
      await db.insert(users).values({
        id: userId,
        email: session.email,
      });
    } catch (error) {
      console.error(
        { error, userId, email: session.email },
        "Failed to create user",
      );
      throw error;
    }
  }

  const userEmail = user?.email || session.email;

  return next({
    context: {
      userId,
      userEmail,
      session,
    },
  });
});
