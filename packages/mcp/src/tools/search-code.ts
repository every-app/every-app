import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import {
  searchFiles,
  getExamplesDir,
  errorResponse,
  textResponse,
  validatePathWithinBase,
} from "../utils.js";

export function registerSearchCodeTool(server: McpServer) {
  server.tool(
    "every_app_mcp_search_code",
    "Search for patterns in the Every App examples using regex. Use this to find implementations of specific patterns.",
    {
      pattern: z.string().describe("Regular expression pattern to search for"),
      path: z
        .string()
        .optional()
        .describe(
          "Path to search within (relative to examples root). Defaults to entire examples directory."
        ),
      filePattern: z
        .string()
        .optional()
        .describe('Glob pattern for files to include (e.g., "**/*.tsx", "**/*.ts")'),
    },
    async ({ pattern, path: inputPath, filePattern }) => {
      const result = getExamplesDir();
      if ("error" in result) {
        return errorResponse(result.error);
      }
      const examplesDir = result.dir;

      // Validate path stays within examples directory
      if (inputPath) {
        const pathValidation = validatePathWithinBase(examplesDir, inputPath);
        if (!pathValidation.valid) {
          return errorResponse(pathValidation.error);
        }
        if (!fs.existsSync(pathValidation.resolvedPath)) {
          return errorResponse(`Path not found: ${inputPath}`);
        }
      }

      try {
        const matches = searchFiles(examplesDir, pattern, {
          filePattern,
          searchPath: inputPath,
          maxResults: 100,
        });

        if (matches.length === 0) {
          return textResponse(`No matches found for pattern: ${pattern}`);
        }

        // Group matches by file
        const byFile = new Map<string, typeof matches>();
        for (const match of matches) {
          const existing = byFile.get(match.file) || [];
          existing.push(match);
          byFile.set(match.file, existing);
        }

        // Format output
        const lines: string[] = [`Found ${matches.length} matches:\n`];
        for (const [file, fileMatches] of byFile) {
          lines.push(file);
          for (const match of fileMatches) {
            lines.push(`  ${match.line}: ${match.text}`);
          }
          lines.push("");
        }

        const truncated = matches.length >= 100;
        if (truncated) {
          lines.push("... (results truncated, refine your search)");
        }

        return textResponse(lines.join("\n"));
      } catch (error) {
        return errorResponse(
          `Search error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }
  );
}
