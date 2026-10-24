import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";

// An in-memory SQLite with the app's migrations stands in for D1.
const testDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/db", () => ({
  get db() {
    return testDb.current;
  },
}));

const { createTodo, deleteTodo, listTodos, updateTodo } = await import(
  "./todos"
);

beforeAll(async () => {
  const db = drizzle(createClient({ url: ":memory:" }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  testDb.current = db;
});

describe("todos", () => {
  it("belong to the user who made them", async () => {
    const mine = await createTodo("alice", { title: "Mine" });
    await createTodo("bob", { title: "Bob's" });

    expect(await listTodos("alice")).toEqual([mine]);
    expect(
      await updateTodo("bob", { id: mine.id, completed: true }),
    ).toBeNull();
    expect(await deleteTodo("bob", { id: mine.id })).toBeNull();
    expect(await updateTodo("alice", { id: mine.id, completed: true })).toEqual(
      {
        ...mine,
        completed: true,
      },
    );
    expect(await deleteTodo("alice", { id: mine.id })).toMatchObject({
      id: mine.id,
    });
    expect(await listTodos("alice")).toEqual([]);
  });
});
