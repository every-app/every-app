/**
 * `everyapp db query` for a person: each statement's rows as an aligned
 * table (or, for one that changed rows, how many), then a dim footer with
 * the count, the database and D1's time. And which SQL only reads, so a
 * write to production is confirmed first.
 */
import chalk from "chalk";
import type { D1Result } from "@/lib/cf/d1";
import { formatTable } from "@/lib/output/table";
import { plural } from "@/lib/output/text";

/** The database a query runs against. */
export type Database = "production" | "local";

export function formatQueryResults(
  results: readonly D1Result[],
  database: Database,
): string {
  const took = time(results.reduce((sum, result) => sum + result.duration, 0));
  if (results.length === 1) {
    const [result] = results as [D1Result];
    if (changedRows(result)) {
      return `${plural(result.changes, "row")} changed ${chalk.green("✓")} ${chalk.dim(`${database} · ${took}`)}`;
    }
    const footer = chalk.dim(`${plural(result.rows.length, "row")} · ${database} · ${took}`);
    return result.rows.length === 0 ? footer : [...table(result), "", footer].join("\n");
  }
  return [
    ...results.flatMap((result) => [
      ...(changedRows(result) ? [`${plural(result.changes, "row")} changed`] : table(result)),
      "",
    ]),
    chalk.dim(`${plural(results.length, "statement")} · ${database} · ${took}`),
  ].join("\n");
}

/** A write: no rows back, some changed. */
const changedRows = (result: D1Result) => result.rows.length === 0 && result.changes > 0;

function table({ rows }: D1Result): string[] {
  const columns = Object.keys(rows[0] ?? {});
  if (columns.length === 0) return [chalk.dim("0 rows")];
  return formatTable(
    columns,
    rows.map((row) => columns.map((column) => cell(row[column]))),
  );
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return chalk.dim("NULL");
  if (typeof value === "string") return value.replaceAll("\n", "\\n");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** D1 reports fractions of a millisecond. */
const time = (ms: number) => (ms < 1 ? "<1ms" : `${Math.round(ms)}ms`);

/** Statements that only read: SELECT, EXPLAIN, VALUES, a WITH that writes nothing, a PRAGMA that sets nothing. */
const READ = [
  /^(select|explain|values)\b/i,
  /^with\b(?![\s\S]*\b(insert|update|delete|replace)\b)/i,
  /^pragma\b[^=]*$/i,
];

/**
 * Whether `sql` only reads. Every statement (split on `;`) must start with
 * a reading keyword: anything else, a comment or a `;` inside a string
 * included, counts as a write, so the doubt is resolved by asking.
 */
export function readsOnly(sql: string): boolean {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  return (
    statements.length > 0 &&
    statements.every((statement) => READ.some((read) => read.test(statement)))
  );
}
