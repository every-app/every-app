import tanstackEntry from "@tanstack/react-start/server-entry";
import { everyApp } from "@every-app/sdk/server";
import { todoMcpHandler } from "./mcp/todoMcp";
import manifest from "../everyapp.config";

export default everyApp<Env>(async (request, env, ctx, user) => {
  if (new URL(request.url).pathname === "/mcp") {
    return todoMcpHandler(request, env, ctx, user);
  }

  return tanstackEntry.fetch(request);
}, manifest);
