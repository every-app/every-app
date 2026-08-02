import tanstackEntry from "@tanstack/react-start/server-entry";
import { everyApp } from "@every-app/sdk/server";
import { handleSyncWebSocket } from "./handlers/sync";
import { todoMcpHandler } from "./mcp/todoMcp";
import manifest from "../everyapp.config";

// Export Durable Objects
export { UserSyncDO } from "./durableObjects/UserSyncDO";

export default everyApp<Env>(async (request, env, _ctx, user) => {
  const url = new URL(request.url);

  if (url.pathname === "/api/sync") {
    return handleSyncWebSocket(request, env, user);
  }

  if (url.pathname === "/mcp") {
    return todoMcpHandler(request, env, _ctx, user);
  }

  return tanstackEntry.fetch(request);
}, manifest);
