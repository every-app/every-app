/**
 * @every-app/sdk/tanstack-start — identity for a TanStack Start app's server
 * functions:
 *
 *   import { ensureUserMiddleware } from "@every-app/sdk/tanstack-start";
 *
 *   export const getTodos = createServerFn()
 *     .middleware([ensureUserMiddleware])
 *     .handler(({ context: { user } }) => listTodos(user.id));
 *
 * The SDK lists `@tanstack/react-start` as a peer dependency, so the Start
 * plugin compiles this module like the app's own: the `.server()` part never
 * reaches the browser.
 */
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { requireEveryAppUser } from "../server/everyApp.js";

/**
 * Puts the person the Gateway signed in on `context.user` (an
 * `EveryAppUser`), verified from the identity the Gateway sent; throws the
 * 401 Response when there is none (a public route, anonymous).
 */
export const ensureUserMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const user = await requireEveryAppUser(getRequest(), env);
  return next({ context: { user } });
});
