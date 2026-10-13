import tanstackEntry from "@tanstack/react-start/server-entry";
import { everyApp } from "@every-app/sdk/server";
import { tools } from "./tools";

// The gateway serves the agent tools at /mcp; everyApp() answers its
// internal tools contract.
export default everyApp<Env>(async (request) => tanstackEntry.fetch(request), {
  tools,
});
