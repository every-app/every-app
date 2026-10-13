/**
 * The MCP repositories against a migrated SQLite database: the audit prune's
 * bounded batches, and how often a connection's last use is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(testDb), schema };
});

import { mcpConnections, mcpToolCalls } from "@/db/schema";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { McpConnectionRepository } from "./McpConnectionRepository";
import { McpToolCallRepository } from "./McpToolCallRepository";

const DAY_MS = 86_400_000;
let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  testDb.current = db;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("McpToolCallRepository.deleteRecordedBefore", () => {
  it("deletes every old row in bounded batches and keeps the rest", async () => {
    const now = Date.now();
    const row = (id: string, ageDays: number) => ({
      id,
      createdAt: new Date(now - ageDays * DAY_MS),
      organizationId: "org",
      userId: "user",
      credentialKind: "pat",
      credentialId: "pat_1",
      surface: "gateway",
      toolName: "todo_list_todos",
      decision: "allowed",
      outcome: "ok",
    });
    const old = Array.from({ length: 2_500 }, (_, i) => row(`old-${i}`, 100));
    // D1 binds at most 100 parameters; insert in small slices.
    for (let i = 0; i < old.length; i += 8) {
      await db.insert(mcpToolCalls).values(old.slice(i, i + 8));
    }
    await db.insert(mcpToolCalls).values([row("recent", 10)]);

    await expect(
      McpToolCallRepository.deleteRecordedBefore(new Date(now - 90 * DAY_MS)),
    ).resolves.toEqual({ deleted: 2_500, done: true });
    expect(await db.select({ id: mcpToolCalls.id }).from(mcpToolCalls)).toEqual(
      [{ id: "recent" }],
    );
  });
});

describe("McpConnectionRepository.touchLastUsed", () => {
  it("writes a use at most every ten minutes", async () => {
    const organizationId = await seedOrganization(db, "acme");
    const userId = await seedMember(db, { organizationId });
    await McpConnectionRepository.create({
      id: "mcpc_1",
      userId,
      organizationId,
      clientId: "client",
      clientName: "Claude",
      clientDomain: null,
      redirectUri: "http://localhost:1/cb",
      redirectHost: "localhost",
      appScope: "all",
      appRowIds: [],
      access: "write",
      createdAt: new Date(),
    });
    const lastUsed = async () =>
      (await db.select().from(mcpConnections))[0]!.lastUsedAt?.getTime();

    const t0 = Date.now();
    await McpConnectionRepository.touchLastUsed("mcpc_1", new Date(t0));
    expect(await lastUsed()).toBe(t0);
    await McpConnectionRepository.touchLastUsed(
      "mcpc_1",
      new Date(t0 + 9 * 60_000),
    );
    expect(await lastUsed()).toBe(t0);
    await McpConnectionRepository.touchLastUsed(
      "mcpc_1",
      new Date(t0 + 11 * 60_000),
    );
    expect(await lastUsed()).toBe(t0 + 11 * 60_000);
  });
});
