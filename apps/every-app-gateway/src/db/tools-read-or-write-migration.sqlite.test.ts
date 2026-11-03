import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The data rewrites in the migration that made tools read or write and
 * tokens read-only, full or a deploy key: every migration before it is
 * applied, rows in the old shapes are seeded, then it runs.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TARGET = fs
  .readdirSync(MIGRATIONS_DIR)
  .find((file) => /^\d{4}_tools_read_or_write\.sql$/.test(file));

function statements(file: string): string[] {
  return fs
    .readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function run(client: Client, file: string) {
  for (const statement of statements(file)) await client.execute(statement);
}

const TOKEN_COLUMNS =
  "id, user_id, organization_id, name, token_hash, token_prefix, scopes, created_at, updated_at, expires_at";

describe(`migration ${TARGET}`, () => {
  let client: Client;

  beforeEach(async () => {
    expect(TARGET).toBeDefined();
    client = createClient({ url: ":memory:" });
    await client.execute("PRAGMA foreign_keys = OFF");
    const earlier = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql") && file < TARGET!)
      .sort();
    for (const file of earlier) await run(client, file);
  });

  it("drops destructive tool rows and rewrites destructive calls as writes", async () => {
    await client.execute(
      `INSERT INTO app_tools (app_row_id, organization_id, name, description, risk, input_schema, catalog_hash)
       VALUES ('app-1', 'org-1', 'delete_todo', 'd', 'destructive', '{}', 'h'),
              ('app-1', 'org-1', 'create_todo', 'c', 'write', '{}', 'h')`,
    );
    await client.execute(
      `INSERT INTO mcp_tool_calls (id, created_at, organization_id, user_id, credential_kind, credential_id, surface, tool_name, risk, decision, outcome)
       VALUES ('call-1', 1, 'org-1', 'user-1', 'pat', 'pat-1', 'app', 'delete_todo', 'destructive', 'blocked', 'denied')`,
    );

    await run(client, TARGET!);

    const tools = await client.execute("SELECT name FROM app_tools");
    expect(tools.rows.map((row) => row.name)).toEqual(["create_todo"]);
    const calls = await client.execute("SELECT risk FROM mcp_tool_calls");
    expect(calls.rows.map((row) => row.risk)).toEqual(["write"]);
  });

  it("turns a remote tool overridden to destructive off and bumps the revision", async () => {
    const manifest = {
      remote: {
        url: "https://mcp.example.com/mcp",
        rev: 3,
        tools: {
          wipe: { risk: "destructive", title: "Wipe" },
          lookup: { risk: "read" },
        },
      },
    };
    await client.execute({
      sql: `INSERT INTO apps (id, organization_id, app_slug, name, description, manifest)
            VALUES ('app-r', 'org-1', 'remote', 'Remote', '', ?),
                   ('app-s', 'org-1', 'sdk', 'SDK', '', '{"name":"sdk"}')`,
      args: [JSON.stringify(manifest)],
    });

    await run(client, TARGET!);

    const rows = await client.execute(
      "SELECT id, manifest FROM apps ORDER BY id",
    );
    const remote = JSON.parse(String(rows.rows[0]!.manifest));
    expect(remote.remote.rev).toBe(4);
    expect(remote.remote.tools).toEqual({
      wipe: { title: "Wipe", enabled: false },
      lookup: { risk: "read" },
    });
    expect(rows.rows[1]!.manifest).toBe('{"name":"sdk"}');
  });

  it("revokes every live token whose scopes are not read, full or deploy", async () => {
    const tokens: Array<[string, string]> = [
      ["full", '["*"]'],
      ["read", '["mcp:read"]'],
      ["deploy", '["deploy"]'],
      ["read-write", '["mcp:read","mcp:write"]'],
      ["write", '["mcp:write"]'],
      ["empty", "[]"],
      ["typed", '["deploy","*"]'],
    ];
    for (const [id, scopes] of tokens) {
      await client.execute({
        sql: `INSERT INTO user_access_tokens (${TOKEN_COLUMNS}) VALUES (?, 'user-1', 'org-1', ?, ?, 'ea_', ?, 1, 1, 9999999999999)`,
        args: [id, id, `hash-${id}`, scopes],
      });
    }

    await run(client, TARGET!);

    const rows = await client.execute(
      "SELECT id, revoked_at, updated_at FROM user_access_tokens ORDER BY id",
    );
    const revoked = rows.rows
      .filter((row) => row.revoked_at !== null)
      .map((row) => row.id)
      .sort();
    expect(revoked).toEqual(["empty", "read-write", "typed", "write"]);
    for (const row of rows.rows) {
      if (row.revoked_at === null) expect(row.updated_at).toBe(1);
      else expect(row.updated_at).toBe(row.revoked_at);
    }
  });
});
