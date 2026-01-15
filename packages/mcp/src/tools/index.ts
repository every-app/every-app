import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListDirectoryTool } from "./list-directory.js";
import { registerReadFileTool } from "./read-file.js";
import { registerSearchCodeTool } from "./search-code.js";
import { registerFindFilesTool } from "./find-files.js";
import { registerBrowseTool } from "./list-examples.js";

export function registerAllTools(server: McpServer) {
  registerListDirectoryTool(server);
  registerReadFileTool(server);
  registerSearchCodeTool(server);
  registerFindFilesTool(server);
  registerBrowseTool(server);
}
