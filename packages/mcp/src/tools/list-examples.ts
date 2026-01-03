import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResponse } from "../utils.js";

interface ExampleApp {
  name: string;
  description: string;
  goodFor: string[];
}

const EXAMPLE_APPS: ExampleApp[] = [
  {
    name: "apps/todo-app",
    description:
      "Simple todo application demonstrating basic CRUD operations, routing, and embedded app patterns",
    goodFor: [
      "Basic data relationships",
      "Complex Drag & Drop",
      "Route setup",
      "Embedded provider usage",
    ],
  },
  {
    name: "apps/workout-tracker",
    description:
      "Workout tracking app with complex data relationships and forms",
    goodFor: [
      "Complex TanstackDB Optimistic Updates",
      "Simple Drag & Drop",
      "Complex data relationships",
      "Form handling",
      "Advanced queries",
    ],
  },
  {
    name: "apps/chef",
    description: "Cooking assistant with LLM integration",
    goodFor: [
      "LLM integration patterns",
      "AI-powered features",
      "Streaming responses",
    ],
  },
];

export function registerListExamplesTool(server: McpServer) {
  server.tool(
    "every_app_mcp_list_examples",
    "List available Every App example applications and what they demonstrate.",
    {},
    async () => {
      const output = EXAMPLE_APPS.map(
        (ex) =>
          `## ${ex.name}\n${ex.description}\n\n**Good for learning:**\n${ex.goodFor.map((g) => `- ${g}`).join("\n")}`,
      ).join("\n\n---\n\n");

      return textResponse(
        `# Available Every App Examples\n\n${output}\n\n---\n\nUse \`every_app_mcp_list_directory\` to explore the structure of any example, and \`every_app_mcp_read_file\` to view implementation details.`,
      );
    },
  );
}
