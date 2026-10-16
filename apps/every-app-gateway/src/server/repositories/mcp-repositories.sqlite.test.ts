/**
 * The MCP repositories against a migrated SQLite database: the audit prune's
 * bounded batches, how often a connection's last use is written, and what
 * superseding a connection retires.
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

import { mcpConnections, mcpToolCalls, members } from "@/db/schema";
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

describe("McpConnectionRepository.supersedeEarlier", () => {
  it("two orgs, two connections for the same client", async () => {
    const orgA = await seedOrganization(db, "org-a");
    const orgB = await seedOrganization(db, "org-b");
    const userId = await seedMember(db, { organizationId: orgA });
    await db.insert(members).values({
      id: "member-b",
      organizationId: orgB,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    const t0 = Date.now();
    const connect = (id: string, organizationId: string, at: number) =>
      McpConnectionRepository.create({
        id,
        userId,
        organizationId,
        clientId: "https://claude.ai/oauth/claude-code-client-metadata",
        clientName: "Claude Code",
        clientDomain: "claude.ai",
        redirectUri: "http://localhost:1/callback",
        redirectHost: "localhost",
        appScope: "all",
        appRowIds: [],
        access: "write",
        createdAt: new Date(at),
      });
    await connect("mcpc_a1", orgA, t0);
    await connect("mcpc_b1", orgB, t0 + 1);
    await connect("mcpc_a2", orgA, t0 + 2);

    // Connecting the same client in org A again retires org A's earlier
    // connection and never org B's, though B's was made in between.
    await expect(
      McpConnectionRepository.supersedeEarlier(
        {
          userId,
          organizationId: orgA,
          clientId: "https://claude.ai/oauth/claude-code-client-metadata",
          createdAt: new Date(t0 + 2),
        },
        () => true,
      ),
    ).resolves.toEqual(["mcpc_a1"]);
    const rows = await db
      .select({
        id: mcpConnections.id,
        revokedReason: mcpConnections.revokedReason,
      })
      .from(mcpConnections)
      .orderBy(mcpConnections.createdAt);
    expect(rows).toEqual([
      { id: "mcpc_a1", revokedReason: "superseded" },
      { id: "mcpc_b1", revokedReason: null },
      { id: "mcpc_a2", revokedReason: null },
    ]);
  });
});
