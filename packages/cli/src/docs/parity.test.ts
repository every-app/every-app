/**
 * Agent parity: everything the Gateway UI can do, the CLI and the Gateway's
 * MCP tools can do (docs/design/2026-10-agent-parity.md). The matrix in
 * that document is this test's fixture:
 *
 *  - every server function the UI calls (`export const <name> =
 *    createServerFn` in apps/every-app-gateway/src/serverFunctions/*.ts)
 *    has one row, as `<file>.<name>`, so a new UI action fails here until
 *    its row says what its CLI command and MCP tool are, or why it has
 *    none (`no CLI:`, `no MCP:` or `no twin:` at the start of the note);
 *  - every CLI command a row names is a route the CLI answers, and every
 *    MCP tool a row names is a built-in the Gateway lists;
 *  - every `workspace …` command and every built-in tool appears in some
 *    row, so the matrix is complete in both directions.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listBuiltinTools } from "@every-app/toolbus";
import { commandPaths } from "@/app";

const ROOT = new URL("../../../../", import.meta.url);
const MATRIX = fileURLToPath(new URL("docs/design/2026-10-agent-parity.md", ROOT));
const SERVER_FUNCTIONS_DIR = fileURLToPath(
  new URL("apps/every-app-gateway/src/serverFunctions/", ROOT),
);

const HOW =
  "Add a row to the matrix in docs/design/2026-10-agent-parity.md (the CLI command and the MCP tool, or a note starting with `no CLI:`, `no MCP:` or `no twin:` and the reason).";

/** A row of either matrix table, by column. */
interface Row {
  action: string;
  /** `<file>.<name>` for the server-function table; how the UI does it otherwise. */
  how: string;
  cli: string;
  mcp: string;
  note: string;
}

/** The backticked spans of a cell, or the bare text when it has none. */
function names(cell: string): string[] {
  const found = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim());
  return found.length > 0 ? found : [cell.trim()];
}

const NONE = "—";
/** A row another PR is landing: its names are not checked for existence yet. */
const isPending = (row: Row): boolean => row.note.startsWith("pending:");

/**
 * The rows of the table under `heading` (a `###` of the "Parity matrix"
 * section): the header and separator skipped, cells unescaped.
 */
function tableRows(markdown: string, heading: string): Row[] {
  const start = markdown.indexOf(`### ${heading}`);
  if (start < 0) throw new Error(`the matrix has no "### ${heading}" table`);
  const section = markdown.slice(start).split(/\n(?=#{2,3} )/)[0]!;
  const lines = section.split("\n").filter((line) => line.startsWith("|"));
  return lines.slice(2).map((line) => {
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.replace(/\\\|/g, "|").trim());
    const [action = "", how = "", cli = "", mcp = "", note = ""] = cells;
    return { action, how, cli, mcp, note };
  });
}

/** Every `export const <name> = createServerFn` as `<file>.<name>`. */
function serverFunctions(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(SERVER_FUNCTIONS_DIR).sort()) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(`${SERVER_FUNCTIONS_DIR}${file}`, "utf8");
    for (const match of source.matchAll(/^export const (\w+)\s*=\s*createServerFn\b/gm)) {
      found.push(`${file.replace(/\.ts$/, "")}.${match[1]}`);
    }
  }
  return found;
}

const matrix = readFileSync(MATRIX, "utf8");
const functionRows = tableRows(matrix, "Server functions (the UI's actions)");
const otherRows = tableRows(matrix, "Other UI actions (not server functions)");
const rows = [...functionRows, ...otherRows];

/** The `<file>.<name>` a server-function row names (its backticks stripped). */
const serverFunctionOf = (row: Row): string => names(row.how)[0]!;

const COMMANDS = new Set(commandPaths());
const TOOLS = new Set(listBuiltinTools().map((tool) => tool.name));

/** A cell that names nothing must say why in the note. */
function gapReason(row: Row, column: "cli" | "mcp"): string | null {
  const prefix = column === "cli" ? "no CLI:" : "no MCP:";
  // At the start of the note, or after a `pending:` sentence.
  if (row.note.startsWith(prefix) || row.note.startsWith("no twin:")) return null;
  if (isPending(row) && (row.note.includes(prefix) || row.note.includes("no twin:"))) return null;
  return `"${row.action}" has no ${column.toUpperCase()} twin and its note doesn't start with \`${prefix}\` or \`no twin:\``;
}

describe("the parity matrix", () => {
  it("has a row for every server function the UI calls", () => {
    const documented = new Set(functionRows.map(serverFunctionOf));
    const missing = serverFunctions().filter((name) => !documented.has(name));
    expect(missing, `server functions without a row in the matrix: ${missing.join(", ")}. ${HOW}`).toEqual([]);
  });

  it("names no server function the Gateway doesn't have", () => {
    const known = new Set(serverFunctions());
    const stale = functionRows.filter((row) => !isPending(row)).map(serverFunctionOf).filter((name) => !known.has(name));
    expect(stale, "rows for server functions that no longer exist (remove or rename them)").toEqual([]);
  });

  it("names each server function once", () => {
    const seen = new Map<string, number>();
    for (const row of functionRows) {
      const name = serverFunctionOf(row);
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    const twice = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    expect(twice, "server functions with more than one row").toEqual([]);
  });

  it("names only CLI commands the CLI answers", () => {
    const unknown: string[] = [];
    for (const row of rows) {
      if (row.cli === NONE || isPending(row)) continue;
      for (const path of names(row.cli)) {
        // A flag or an option after the path is fine; the path must exist.
        const command = path.replace(/\s+-.*$/, "").trim();
        if (!COMMANDS.has(command)) unknown.push(`"${row.action}": ${path}`);
      }
    }
    expect(unknown, "rows naming a CLI command the CLI doesn't answer (see commandPaths in packages/cli/src/app.ts)").toEqual([]);
  });

  it("names only MCP tools the Gateway lists", () => {
    const unknown: string[] = [];
    for (const row of rows) {
      if (row.mcp === NONE || isPending(row)) continue;
      for (const tool of names(row.mcp)) {
        if (!TOOLS.has(tool)) unknown.push(`"${row.action}": ${tool}`);
      }
    }
    expect(unknown, "rows naming an MCP tool the Gateway doesn't list (see listBuiltinTools in packages/toolbus)").toEqual([]);
  });

  it("gives a reason for every gap", () => {
    const unexplained: string[] = [];
    for (const row of rows) {
      if (row.cli === NONE) {
        const problem = gapReason(row, "cli");
        if (problem) unexplained.push(problem);
      }
      if (row.mcp === NONE) {
        const problem = gapReason(row, "mcp");
        if (problem) unexplained.push(problem);
      }
    }
    expect(unexplained, `gaps without a reason. ${HOW}`).toEqual([]);
  });

  it("drops `pending:` once what a row names exists", () => {
    const known = new Set(serverFunctions());
    const done = rows.filter(isPending).filter((row) => {
      const fn = functionRows.includes(row) ? known.has(serverFunctionOf(row)) : true;
      const cli = row.cli === NONE || names(row.cli).every((path) => COMMANDS.has(path.replace(/\s+-.*$/, "").trim()));
      const mcp = row.mcp === NONE || names(row.mcp).every((tool) => TOOLS.has(tool));
      return fn && cli && mcp;
    });
    expect(done.map((row) => row.action), "rows still marked `pending:` though everything they name exists (remove the prefix)").toEqual([]);
  });

  it("covers every workspace command", () => {
    const named = new Set(rows.flatMap((row) => (row.cli === NONE ? [] : names(row.cli))).map((path) => path.replace(/\s+-.*$/, "").trim()));
    // Leaf commands only: a group ("workspace", "workspace group") is not an action.
    const leaves = [...COMMANDS].filter(
      (path) =>
        path.startsWith("workspace ") && ![...COMMANDS].some((other) => other.startsWith(`${path} `)),
    );
    const missing = leaves.filter((path) => !named.has(path));
    expect(missing, "workspace commands no row of the matrix names").toEqual([]);
  });

  it("covers every built-in tool", () => {
    const named = new Set(rows.flatMap((row) => (row.mcp === NONE ? [] : names(row.mcp))));
    // The search tool and the two call wrappers are how a client reaches
    // the others, not actions of the UI.
    const reachers = new Set(["everyapp_search_tools", "everyapp_call_read", "everyapp_call_write"]);
    const missing = [...TOOLS].filter((tool) => !named.has(tool) && !reachers.has(tool));
    expect(missing, "built-in tools no row of the matrix names").toEqual([]);
  });
});
