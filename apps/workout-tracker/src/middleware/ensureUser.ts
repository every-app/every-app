import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireEveryAppUser } from "@every-app/sdk/server";
import { env } from "cloudflare:workers";

export const ensureUserMiddleware = createMiddleware({
  type: "function",
}).server(async (c) => {
  const { next } = c;

  let identityUser;
  try {
    identityUser = await requireEveryAppUser(getRequest(), env);
  } catch (error) {
    if (error instanceof Response && error.status === 401) {
      throw new Response("Unauthenticated", { status: 401 });
    }
    throw error;
  }

  if (!identityUser.email) {
    throw new Error("Email should always be on our session tokens.");
  }

  const userId = identityUser.id;

  // Check if user exists
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!user) {
    try {
      await db.insert(users).values({
        id: userId,
        email: identityUser.email,
      });
    } catch (error) {
      console.error(
        { error, userId, email: identityUser.email },
        "Failed to create user",
      );
      throw error;
    }
  }

  const userEmail = user?.email || identityUser.email;

  return next({
    context: {
      userId,
      userEmail,
      user: identityUser,
    },
  });
});
