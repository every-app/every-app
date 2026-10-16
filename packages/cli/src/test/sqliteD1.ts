/**
 * A real SQLite database standing in for remote D1 in tests: behind the
 * `D1Database` seam, and behind FakeCf as `cf d1 query` and
 * `cf d1 migrations apply`, so the CLI's SQL (lease, setup link, desired
 * state, install row) runs against the gateway's actual schema.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import type { FakeCfResponse, RecordedCfCall } from "@/lib/cf/fakeCf";

export const GATEWAY_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../apps/every-app-gateway/drizzle", import.meta.url),
);

export interface SqliteD1 extends D1Database {
  sqlite: DatabaseSync;
  /** Rows of a query, for assertions. */
  all(sql: string, ...params: SQLInputValue[]): Record<string, unknown>[];
}

export function createSqliteD1(): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  const run = async (statements: readonly D1Statement[]) => {
    sqlite.exec("BEGIN");
    try {
      const results = statements.map(
        ({ sql, params = [] }) =>
          sqlite.prepare(sql).all(...params) as Record<string, unknown>[],
      );
      sqlite.exec("COMMIT");
      return results.map((rows) => rows.map((row) => ({ ...row })));
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    sqlite,
    run,
    all: (sql, ...params) =>
      (sqlite.prepare(sql).all(...params) as Record<string, unknown>[]).map(
        (row) => ({ ...row }),
      ),
  };
}

function migrationFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function execMigration(sqlite: DatabaseSync, file: string): void {
  for (const statement of fs
    .readFileSync(file, "utf8")
    .split("--> statement-breakpoint")) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

/** Parse the body FakeCf recorded for `cf d1 query … --body @file`. */
function statementsOf(call: RecordedCfCall): D1Statement[] {
  const body = JSON.parse(call.files["query.json"] ?? "{}") as
    | D1Statement
    | { batch: D1Statement[] };
  return "batch" in body ? body.batch : [body];
}

function cfFailure(message: string): FakeCfResponse {
  return { exitCode: 1, stderr: `┌ Error\n│ ${message}\n└\n` };
}

/**
 * A FakeCf script for `cf d1 query <id>` and `cf d1 migrations apply <id>`
 * against the SQLite databases in `databases`, by D1 id.
 */
export function sqliteD1Script(
  databases: Record<string, SqliteD1>,
): (call: RecordedCfCall) => Promise<FakeCfResponse> {
  return async (call) => {
    const command = call.args[1];
    const id = command === "query" ? call.args[2] : call.args[3];
    const db = databases[id ?? ""];
    if (!db) return cfFailure(`The database ${id} could not be found [code: 7404]`);

    if (command === "query") {
      try {
        const results = await db.run(statementsOf(call));
        return {
          stdout: JSON.stringify(
            results.map((rows) => ({ results: rows, success: true })),
          ),
        };
      } catch (error) {
        return cfFailure(`${(error as Error).message}: SQLITE_ERROR [code: 7500]`);
      }
    }

    // `cf d1 migrations apply <id> --dir <dir>`, as cf runs it.
    const dir = call.args[call.args.indexOf("--dir") + 1]!;
    db.sqlite.exec(
      'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    );
    const done = new Set(
      db.all("SELECT name FROM d1_migrations").map((row) => row["name"]),
    );
    const applied: Array<{ name: string; status: string }> = [];
    for (const file of migrationFiles(dir).filter((f) => !done.has(f))) {
      db.sqlite.exec("BEGIN");
      try {
        execMigration(db.sqlite, path.join(dir, file));
        db.sqlite
          .prepare("INSERT INTO d1_migrations (name) VALUES (?)")
          .run(file);
        db.sqlite.exec("COMMIT");
        applied.push({ name: file, status: "✅" });
      } catch (error) {
        db.sqlite.exec("ROLLBACK");
        return cfFailure(`${(error as Error).message}: SQLITE_ERROR [code: 7500]`);
      }
    }
    return { stdout: JSON.stringify(applied) };
  };
}
