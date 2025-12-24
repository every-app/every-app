import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorResponse, textResponse } from "../utils.js";

const AVAILABLE_DOCS = `Available pages include:
- introduction
- tech-stack/overview
- tech-stack/tanstack-start
- tech-stack/drizzle
- tech-stack/cloudflare
- embedded-sdk/overview
- embedded-sdk/client
- embedded-sdk/server
- build-an-app/start-from-template
- build-an-app/development-workflow
- build-an-app/deployment
- coding-agent/setup`;

export function registerFetchDocsTool(server: McpServer) {
  server.tool(
    "every_app_mcp_fetch_docs",
    "Fetch content from the Every App documentation. Use this to understand concepts, APIs, and best practices.",
    {
      page: z
        .string()
        .describe(
          'Documentation page path (e.g., "introduction", "tech-stack/drizzle", "embedded-sdk/client")'
        ),
    },
    async ({ page }) => {
      // Validate page contains only safe characters (alphanumeric, hyphens, slashes)
      if (!/^[a-zA-Z0-9\-\/]+$/.test(page)) {
        return errorResponse(
          `Invalid page path: ${page}\n\n${AVAILABLE_DOCS}`
        );
      }

      // Try to read from local docs directory first
      const docsDir = process.env.EVERY_APP_DOCS_DIR;

      if (docsDir) {
        // Try to read from local docs directory
        const localPath = path.join(docsDir, `${page}.mdx`);
        if (fs.existsSync(localPath)) {
          const content = fs.readFileSync(localPath, "utf-8");
          return textResponse(`# ${page}\n\n${content}`);
        }

        // Try without .mdx extension (might be a directory index)
        const indexPath = path.join(docsDir, page, "index.mdx");
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath, "utf-8");
          return textResponse(`# ${page}\n\n${content}`);
        }
      }

      // Fallback to fetching from GitHub raw content
      const rawUrl = `https://raw.githubusercontent.com/every-app/every-app/main/landing-page/src/content/docs/docs/${page}.mdx`;

      try {
        const response = await fetch(rawUrl);
        if (!response.ok) {
          return errorResponse(
            `Documentation page not found: ${page}\n\n${AVAILABLE_DOCS}`
          );
        }

        const content = await response.text();
        return textResponse(`# ${page}\n\n${content}`);
      } catch (error) {
        return errorResponse(
          `Error fetching docs: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }
  );
}
