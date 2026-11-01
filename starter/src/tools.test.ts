import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { callTool, listTools } from "@every-app/sdk/testing";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";

// The tools called the way the Gateway calls them for an AI client: each
// with an identity minted for the one call, through the SDK's tools
// endpoint, which checks the caller's scopes and the input. The same
// in-memory SQLite as todos.test.ts stands in for D1.
const testDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/db", () => ({
  get db() {
    return testDb.current;
  },
}));

const { tools } = await import("./tools");

beforeAll(async () => {
  const db = drizzle(createClient({ url: ":memory:" }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  testDb.current = db;
});

describe("tools", () => {
  it("lists each tool with its risk", async () => {
    const { tools: listed } = await listTools(tools);
    expect(listed.map(({ name, risk }) => [name, risk])).toEqual([
      ["create_todo", "write"],
      ["delete_todo", "destructive"],
      ["list_todos", "read"],
      ["update_todo", "write"],
    ]);
  });

  it("acts for the person calling, and only on their todos", async () => {
    await callTool(
      tools,
      "create_todo",
      { title: "Ana's" },
      { user: { id: "ana" } },
    );
    const bo = await callTool(tools, "list_todos", {}, { user: { id: "bo" } });
    expect(bo).toMatchObject({ result: { content: [{ text: "[]" }] } });
  });

  it("refuses a caller whose connection may only read", async () => {
    const response = await callTool(
      tools,
      "create_todo",
      { title: "Nope" },
      { scopes: ["mcp:read"] },
    );
    expect(response).toMatchObject({ error: { code: "forbidden" } });
  });
});
