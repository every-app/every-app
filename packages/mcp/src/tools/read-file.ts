import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import { getExamplesDir, errorResponse, textResponse, validatePathWithinBase } from "../utils.js";

export function registerReadFileTool(server: McpServer) {
  server.tool(
    "every_app_mcp_read_file",
    "Read the contents of a file from the Every App examples. Use this to see how patterns are implemented.",
    {
      path: z
        .string()
        .describe(
          'Path relative to the Every App examples root (e.g., "apps/todo-app/src/routes/index.tsx")'
        ),
      startLine: z
        .number()
        .optional()
        .describe("Line number to start reading from (1-based). Defaults to 1."),
      endLine: z
        .number()
        .optional()
        .describe(
          "Line number to stop reading at (inclusive). Defaults to end of file."
        ),
    },
    async ({ path: inputPath, startLine, endLine }) => {
      const result = getExamplesDir();
      if ("error" in result) {
        return errorResponse(result.error);
      }
      const examplesDir = result.dir;

      // Validate path stays within examples directory
      const pathValidation = validatePathWithinBase(examplesDir, inputPath);
      if (!pathValidation.valid) {
        return errorResponse(pathValidation.error);
      }
      const filePath = pathValidation.resolvedPath;

      if (!fs.existsSync(filePath)) {
        return errorResponse(`File not found: ${inputPath}`);
      }

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return errorResponse(
          `Path is a directory, not a file: ${inputPath}. Use list_directory instead.`
        );
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      const start = Math.max(1, startLine || 1);
      const end = Math.min(lines.length, endLine || lines.length);

      const selectedLines = lines.slice(start - 1, end);
      const numberedLines = selectedLines.map(
        (line, idx) => `${(start + idx).toString().padStart(5, " ")}| ${line}`
      );

      const header = `File: ${inputPath} (lines ${start}-${end} of ${lines.length})`;
      const output = [header, "─".repeat(60), ...numberedLines].join("\n");

      return textResponse(output);
    }
  );
}
