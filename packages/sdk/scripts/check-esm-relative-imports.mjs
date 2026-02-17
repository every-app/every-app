import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sdkRoot = join(__dirname, "..");
const srcRoot = join(sdkRoot, "src");

const allowedExtensions = [".js", ".json", ".mjs", ".cjs"];
const importExportRegex =
  /(?:import\s+(?:type\s+)?[^;]*?from\s+|export\s+(?:type\s+)?[^;]*?from\s+)(["'])([^"']+)\1/gm;

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    const isTypeScriptFile =
      fullPath.endsWith(".ts") || fullPath.endsWith(".tsx");
    const isTestFile = /\.test\.(ts|tsx)$/.test(fullPath);

    if (isTypeScriptFile && !isTestFile) {
      files.push(fullPath);
    }
  }

  return files;
}

function hasAllowedExtension(specifier) {
  return allowedExtensions.some((extension) => specifier.endsWith(extension));
}

const failures = [];
const sourceFiles = walk(srcRoot);

for (const filePath of sourceFiles) {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split("\n");

  for (const match of source.matchAll(importExportRegex)) {
    const specifier = match[2];

    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      continue;
    }

    if (hasAllowedExtension(specifier)) {
      continue;
    }

    const position = match.index ?? 0;
    const lineNumber = source.slice(0, position).split("\n").length;

    failures.push({
      file: relative(sdkRoot, filePath),
      line: lineNumber,
      specifier,
      sourceLine: lines[lineNumber - 1]?.trim() ?? "",
    });
  }
}

if (failures.length > 0) {
  console.error(
    "Found relative ESM import/export specifiers without explicit file extensions:",
  );

  for (const failure of failures) {
    console.error(
      `- ${failure.file}:${failure.line} -> \"${failure.specifier}\" (${failure.sourceLine})`,
    );
  }

  process.exit(1);
}

console.log(
  "All relative ESM import/export specifiers include explicit extensions.",
);
