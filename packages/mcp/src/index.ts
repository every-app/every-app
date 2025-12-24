#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";
import { ensureExamplesExist } from "./setup.js";

// Create server instance
const server = new McpServer({
  name: "every-app",
  version: "0.0.1",
});

// Register all tools and resources
registerAllTools(server);
registerAllResources(server);

// Main function
async function main() {
  // Ensure examples are available (clone if needed)
  const setupResult = await ensureExamplesExist();
  if (!setupResult.success) {
    console.error(`Warning: ${setupResult.message}`);
    console.error("Some tools may not work correctly without the examples.");
  } else {
    console.error(setupResult.message);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Every App MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
