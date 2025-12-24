import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import {
  findFiles,
  getExamplesDir,
  errorResponse,
  textResponse,
  validatePathWithinBase,
} from "../utils.js";

export function registerFindFilesTool(server: McpServer) {
  server.tool(
    "every_app_mcp_find_files",
    "Find files matching a glob pattern in the Every App examples.",
    {
      pattern: z
        .string()
        .describe('Glob pattern to match (e.g., "**/*.tsx", "**/schema.ts")'),
      path: z
        .string()
        .optional()
        .describe(
          "Path to search within (relative to examples root). Defaults to entire examples directory."
        ),
    },
    async ({ pattern, path: inputPath }) => {
      const result = getExamplesDir();
      if ("error" in result) {
        return errorResponse(result.error);
      }
      const examplesDir = result.dir;

      // Validate path stays within examples directory
      let searchPath = examplesDir;
      if (inputPath) {
        const pathValidation = validatePathWithinBase(examplesDir, inputPath);
        if (!pathValidation.valid) {
          return errorResponse(pathValidation.error);
        }
        searchPath = pathValidation.resolvedPath;
      }

      if (!fs.existsSync(searchPath)) {
        return errorResponse(`Path not found: ${inputPath || "(root)"}`);
      }

      try {
        const files = findFiles(searchPath, pattern, { maxResults: 100 });

        if (files.length === 0) {
          return textResponse(`No files found matching: ${pattern}`);
        }

        // Prepend the input path to make paths relative to examples root
        const displayFiles = inputPath
          ? files.map((f) => `${inputPath}/${f}`)
          : files;

        const truncated = files.length >= 100;
        let output = displayFiles.join("\n");
        if (truncated) {
          output += "\n\n... (results truncated, refine your pattern)";
        }

        return textResponse(`Found ${files.length} files:\n\n${output}`);
      } catch (error) {
        return errorResponse(
          `Search error: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }
  );
}
