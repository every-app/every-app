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
      "Embedded provider usage",
      "Basic data relationships",
      "Complex Drag & Drop and fractional indexing for ordering",
      "Keybindings and keyboard based navigation",
      "Route setup",
    ],
  },
  {
    name: "apps/workout-tracker",
    description:
      "Workout tracking app with complex data relationships and forms",
    goodFor: [
      "Complex TanstackDB Optimistic Updates",
      "Simple Drag & Drop",
      "Slide animations for mobile navigation",
      "Complex data relationships and drizzle schema",
      "Form handling",
      "Advanced queries",
    ],
  },
  {
    name: "apps/chef",
    description:
      "AI-powered cooking assistant with image analysis and recipe management",
    goodFor: [
      "Authenticated image upload and access (R2 storage with auth-gated retrieval)",
      "AI Chat with image upload, mobile camera access, and optimistic UI updates",
      "Streaming AI responses with database persistence",
      "Human-in-loop AI tools (AI suggests, user approves)",
      "Multi-part messages (text, images, tool invocations)",
      "Drawer based mobile navigation instead of TabBar due to wanting to show list of chats nicely. Helpful for any UI which needs dynamic navigation instead of 4 or 5 TabBar items.",
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
