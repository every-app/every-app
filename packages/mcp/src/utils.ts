import * as fs from "node:fs";
import * as path from "node:path";
import { getExamplesDirectory } from "./setup.js";

// Ignore patterns for directory listings and searches
export const IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".wrangler",
  ".mf",
];

// Binary file extensions to skip when searching
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".lock",
]);

// Helper to get examples directory or return error
export function getExamplesDir(): { dir: string } | { error: string } {
  const examplesDir = getExamplesDirectory();

  if (!fs.existsSync(examplesDir)) {
    return {
      error: `Examples directory not found at ${examplesDir}. The server may still be initializing - please try again in a moment.`,
    };
  }

  return { dir: examplesDir };
}

// Helper to create error response
export function errorResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

// Validate that a resolved path stays within the base directory (prevents path traversal)
export function validatePathWithinBase(
  baseDir: string,
  inputPath: string
): { valid: true; resolvedPath: string } | { valid: false; error: string } {
  let resolvedBase: string;
  try {
    resolvedBase = fs.realpathSync(baseDir);
  } catch {
    return { valid: false, error: "Base directory not accessible" };
  }

  const resolvedPath = path.resolve(resolvedBase, inputPath);

  if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
    return {
      valid: false,
      error: "Path traversal detected - access denied",
    };
  }

  if (fs.existsSync(resolvedPath)) {
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolvedPath);
    } catch {
      return { valid: false, error: "Path not accessible" };
    }

    if (!realPath.startsWith(resolvedBase + path.sep) && realPath !== resolvedBase) {
      return { valid: false, error: "Path resolves outside base directory" };
    }
  }

  return { valid: true, resolvedPath };
}

// Helper to create success response
export function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

// Check if a path should be ignored
function shouldIgnore(name: string): boolean {
  return IGNORE_PATTERNS.includes(name) || name.startsWith(".");
}

// Check if a file is binary based on extension
function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// Recursively find all files matching a glob-like pattern
export function findFiles(
  baseDir: string,
  pattern: string,
  options: { maxResults?: number } = {}
): string[] {
  const { maxResults = 500 } = options;
  const results: string[] = [];

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/{{GLOBSTAR}}/g, ".*");
  const regex = new RegExp(`^${regexPattern}$`);

  function walk(dir: string, relativePath: string = ""): void {
    if (results.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (shouldIgnore(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (regex.test(relPath)) {
          results.push(relPath);
        }
      }
    }
  }

  walk(baseDir);
  return results;
}

// Search for a pattern in files
export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export function searchFiles(
  baseDir: string,
  searchPattern: string,
  options: {
    filePattern?: string;
    maxResults?: number;
    searchPath?: string;
  } = {}
): SearchMatch[] {
  const { filePattern, maxResults = 100, searchPath } = options;
  const matches: SearchMatch[] = [];

  const searchDir = searchPath ? path.join(baseDir, searchPath) : baseDir;

  // Get all files to search
  const globPattern = filePattern || "**/*";
  const files = findFiles(searchDir, globPattern, { maxResults: 1000 });

  let regex: RegExp;
  try {
    regex = new RegExp(searchPattern, "gi");
  } catch {
    throw new Error(`Invalid regex pattern: ${searchPattern}`);
  }

  for (const file of files) {
    if (matches.length >= maxResults) break;

    const fullPath = path.join(searchDir, file);

    // Skip binary files
    if (isBinaryFile(fullPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      continue; // Skip files we can't read
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) break;

      const line = lines[i];
      regex.lastIndex = 0; // Reset regex state
      if (regex.test(line)) {
        const relativePath = searchPath ? `${searchPath}/${file}` : file;
        matches.push({
          file: relativePath,
          line: i + 1,
          text: line.length > 200 ? line.substring(0, 200) + "..." : line,
        });
      }
    }
  }

  return matches;
}
