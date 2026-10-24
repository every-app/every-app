import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireEveryAppUser } from "@every-app/sdk/server";
import { env } from "cloudflare:workers";

// The Gateway signed this person in; the SDK verifies the token it sent.
// Throws the 401 Response when there is none (a public route, anonymous).
export const ensureUserMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const user = await requireEveryAppUser(getRequest(), env);
  return next({ context: { user } });
});
