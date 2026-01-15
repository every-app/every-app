import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { textResponse } from "../utils.js";
import { getExamplesDirectory } from "../setup.js";

interface CodebaseEntry {
  name: string;
  description: string;
  goodFor: string[];
}

const EXAMPLE_APPS: CodebaseEntry[] = [
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

const INTERNAL_PACKAGES: CodebaseEntry[] = [
  {
    name: "apps/every-app-gateway",
    description:
      "The Every App Gateway - central authentication hub that manages user accounts and hosts embedded apps",
    goodFor: [
      "Understanding how authentication flows work",
      "How embedded apps are loaded and displayed",
      "JWT token generation and validation",
      "User session management",
      "How the Gateway communicates with embedded apps via postMessage",
    ],
  },
  {
    name: "packages/sdk",
    description:
      "The @every-app/sdk package - client and server utilities for building Every Apps",
    goodFor: [
      "EmbeddedAppProvider implementation",
      "Session management and authentication helpers",
      "Server-side request authentication",
      "Understanding how apps communicate with the Gateway",
    ],
  },
  {
    name: "packages/cli",
    description:
      "The @every-app/cli package - command-line tool for creating and deploying Every Apps",
    goodFor: [
      "How app creation works (templates, scaffolding)",
      "Deployment flow to Cloudflare",
      "Gateway deployment and configuration",
      "Database migrations and secret management",
    ],
  },
  {
    name: "packages/mcp",
    description:
      "The @every-app/mcp package - MCP server that provides access to examples and documentation",
    goodFor: [
      "How this MCP server is built",
      "Example of building MCP tools",
      "Sparse git checkout patterns",
    ],
  },
];

/**
 * Recursively find all .mdx files in a directory and return their paths relative to the base
 */
function findMdxFiles(dir: string, basePath: string = ""): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push(...findMdxFiles(fullPath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      // Remove .mdx extension for display
      results.push(relativePath.replace(/\.mdx$/, ""));
    }
  }

  return results;
}

/**
 * Get the docs directory path
 */
function getDocsDirectory(): string {
  return path.join(
    getExamplesDirectory(),
    "landing-page/src/content/docs/docs"
  );
}

function formatEntries(entries: CodebaseEntry[]): string {
  return entries
    .map(
      (entry) =>
        `## ${entry.name}\n${entry.description}\n\n**Good for learning:**\n${entry.goodFor.map((g) => `- ${g}`).join("\n")}`
    )
    .join("\n\n---\n\n");
}

export function registerBrowseTool(server: McpServer) {
  server.tool(
    "browse",
    "Browse available Every App resources: example apps, internal packages, and documentation. Start here to discover what's available.",
    {},
    async () => {
      const examplesOutput = formatEntries(EXAMPLE_APPS);
      const internalsOutput = formatEntries(INTERNAL_PACKAGES);

      // Dynamically discover docs
      const docsDir = getDocsDirectory();
      const docPages = findMdxFiles(docsDir).sort();
      const docsOutput =
        docPages.length > 0
          ? `Use \`read_file\` with path \`landing-page/src/content/docs/docs/<page>.mdx\` to read any of these:\n\n${docPages.map((p) => `- ${p}`).join("\n")}`
          : "Documentation not available. Try reconnecting the MCP server to trigger a fresh clone.";

      return textResponse(
        `# Every App Resources

**Note:** Code examples are from the latest version on GitHub. The user may be on an older version of the SDK, CLI, or Gateway. If something doesn't match what they're seeing, check their package versions.

---

# Documentation
${docsOutput}

---

# Example Applications
Complete example apps you can learn from. Use \`list_directory\` and \`read_file\` to explore:

${examplesOutput}

---

# Internal Packages
Core Every App packages - useful for understanding how Every App works:

${internalsOutput}`
      );
    }
  );
}
