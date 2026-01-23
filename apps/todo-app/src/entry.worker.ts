// Custom worker entry that re-exports TanStack Start's server entry
// and also exports our Durable Objects

import tanstackEntry from "@tanstack/react-start/server-entry";
import { handleSyncWebSocket } from "./handlers/sync";

// Re-export everything from TanStack Start's server entry
export * from "@tanstack/react-start/server-entry";

// Export Durable Objects
export { UserSyncDO } from "./durableObjects/UserSyncDO";

// Custom fetch handler that intercepts WebSocket requests for sync
export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket sync connections
    if (url.pathname === "/api/sync") {
      return handleSyncWebSocket(request, env);
    }

    // Pass through to TanStack Start for all other requests
    return tanstackEntry.fetch(request);
  },
};
