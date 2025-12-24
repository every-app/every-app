import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPromptResources } from "./prompts.js";

export function registerAllResources(server: McpServer) {
  registerPromptResources(server);
}
