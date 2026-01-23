import { createMiddleware } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

const SYNC_DO_EMIT_URL = "http://durable-object/emit";

/**
 * Middleware that emits a sync event after a server function successfully completes.
 *
 * Usage:
 * ```ts
 * export const createTodo = createServerFn()
 *   .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware, emitSyncEvent("createTodo")])
 *   .handler(...)
 * ```
 *
 * The event will be broadcast to all connected WebSocket clients for the user,
 * allowing them to invalidate their queries and refetch.
 *
 * NOTE: This middleware must be used after ensureUserMiddleware to have access
 * to the userId in the context.
 */
export function emitSyncEvent(eventName: string) {
  return createMiddleware({ type: "function" }).server(async (c) => {
    const { next, context } = c;

    const result = await next();

    // After successful completion, emit the sync event
    // Context is set by ensureUserMiddleware which must run before this middleware
    const ctx = context as { userId?: string } | undefined;
    const userId = ctx?.userId;
    if (userId) {
      await emitToUserSync(userId, eventName);
    }

    return result;
  });
}

/**
 * Emit a sync event to the UserSyncDO for the given user.
 * This broadcasts to all connected WebSocket clients.
 */
async function emitToUserSync(userId: string, event: string): Promise<void> {
  if (!env.USER_SYNC) {
    throw new Error("USER_SYNC binding not available");
  }

  const id = env.USER_SYNC.idFromName(userId);
  const stub = env.USER_SYNC.get(id);

  await stub.fetch(
    new Request(SYNC_DO_EMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    }),
  );
}
