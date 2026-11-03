/**
 * The migration that folds the per-provider model memory (`ai_models`) into
 * the one default-model setting, run on rows a Gateway from before it held:
 * a stored provider with a chat model keeps it as `provider/model`; a
 * provider with no chat model there, malformed JSON, an embeddings-only
 * entry and a setting that already names a model stay as they were; a row
 * with no stored default loses its models (the catalog's serve).
 */
import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();
// Found by name, not number, so a renumbering at merge time doesn't break it.
const target = migrations.find((file) =>
  file.endsWith("_ai_default_one_setting.sql"),
);

async function apply(client: Client, file: string): Promise<void> {
  const sql = fs.readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.execute(statement);
  }
}

describe("ai_default one-setting migration", () => {
  let client: Client;

  beforeAll(async () => {
    expect(target).toBeDefined();
    client = createClient({ url: ":memory:" });
    await client.execute("PRAGMA foreign_keys = OFF");
    for (const file of migrations.slice(0, migrations.indexOf(target!))) {
      await apply(client, file);
    }
    const rows: Array<[string, string | null, string | null]> = [
      [
        "folds",
        "openrouter",
        JSON.stringify({ openrouter: { chat: "anthropic/claude-sonnet-5.5" } }),
      ],
      [
        "no-chat",
        "openai",
        JSON.stringify({ openai: { embeddings: "text-embedding-3-large" } }),
      ],
      [
        "other-provider",
        "openai",
        JSON.stringify({ openrouter: { chat: "x/y" } }),
      ],
      ["malformed", "openrouter", "{not json"],
      [
        "already-model",
        "openrouter/a/b",
        JSON.stringify({ openrouter: { chat: "c/d" } }),
      ],
      ["no-default", null, JSON.stringify({ openrouter: { chat: "x/y" } })],
      ["provider-only", "anthropic", null],
    ];
    for (const [org, aiDefault, aiModels] of rows) {
      await client.execute({
        sql: "INSERT INTO org_settings (organization_id, ai_default, ai_models, updated_at) VALUES (?, ?, ?, 0)",
        args: [org, aiDefault, aiModels],
      });
    }
    await apply(client, target!);
  });

  it("keeps the stored provider's chat model in the one setting and drops the rest", async () => {
    const { rows } = await client.execute(
      "SELECT organization_id, ai_default FROM org_settings ORDER BY organization_id",
    );
    expect(
      Object.fromEntries(
        rows.map((row) => [row["organization_id"], row["ai_default"]]),
      ),
    ).toEqual({
      "already-model": "openrouter/a/b",
      folds: "openrouter/anthropic/claude-sonnet-5.5",
      malformed: "openrouter",
      "no-chat": "openai",
      "no-default": null,
      "other-provider": "openai",
      "provider-only": "anthropic",
    });
  });

  it("drops the ai_models column", async () => {
    const { rows } = await client.execute("PRAGMA table_info(org_settings)");
    expect(rows.map((row) => row["name"])).not.toContain("ai_models");
  });
});
