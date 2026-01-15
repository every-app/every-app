import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  IGNORE_PATTERNS,
  getExamplesDir,
  errorResponse,
  textResponse,
  validatePathWithinBase,
} from "../utils.js";

export function registerListDirectoryTool(server: McpServer) {
  server.tool(
    "list_directory",
    "List files and directories in the Every App examples. Use this to explore the structure of example apps.",
    {
      path: z
        .string()
        .optional()
        .describe(
          'Path relative to the Every App examples root (e.g., "apps/todo-app/src"). Defaults to root.'
        ),
    },
    async ({ path: inputPath }) => {
      const result = getExamplesDir();
      if ("error" in result) {
        return errorResponse(result.error);
      }
      const examplesDir = result.dir;

      // Validate path stays within examples directory
      let targetPath = examplesDir;
      if (inputPath) {
        const pathValidation = validatePathWithinBase(examplesDir, inputPath);
        if (!pathValidation.valid) {
          return errorResponse(pathValidation.error);
        }
        targetPath = pathValidation.resolvedPath;
      }

      if (!fs.existsSync(targetPath)) {
        return errorResponse(`Directory not found: ${inputPath || "(root)"}`);
      }

      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
        return errorResponse(`Path is not a directory: ${inputPath}`);
      }

      // Build directory tree
      function buildTree(dir: string, prefix = "", depth = 0): string[] {
        if (depth > 3) return [`${prefix}...`]; // Limit depth

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const filtered = entries.filter(
          (e) => !IGNORE_PATTERNS.includes(e.name) && !e.name.startsWith(".")
        );
        const lines: string[] = [];

        filtered.forEach((entry, idx) => {
          const isLast = idx === filtered.length - 1;
          const connector = isLast ? "└── " : "├── ";
          const childPrefix = isLast ? "    " : "│   ";

          lines.push(
            `${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`
          );

          if (entry.isDirectory()) {
            const subLines = buildTree(
              path.join(dir, entry.name),
              prefix + childPrefix,
              depth + 1
            );
            lines.push(...subLines);
          }
        });

        return lines;
      }

      const tree = buildTree(targetPath);
      const output = [`${inputPath || "."}/`, ...tree].join("\n");

      return textResponse(output);
    }
  );
}
