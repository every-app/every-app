/**
 * Listing the MCP audit trail for Admin → Activity against a migrated
 * SQLite database: one organization's rows only, a keyset page that holds
 * still across equal timestamps, the filters, and who a row shows as.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(testDb), schema };
});

import { apps, mcpToolCalls } from "@/db/schema";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { AppRepository } from "./AppRepository";
import {
  McpToolCallRepository,
  TOOL_CALL_PAGE_MAX,
} from "./McpToolCallRepository";

const AT = Date.parse("2026-10-23T12:00:00.000Z");
const HOUR_MS = 3_600_000;

type Insert = typeof mcpToolCalls.$inferInsert;

/** An allowed read on the Chef app, at `AT` unless said otherwise. */
function call(
  id: string,
  overrides: Partial<Insert> & Pick<Insert, "organizationId" | "userId">,
): Insert {
  return {
    id,
    createdAt: new Date(AT),
    credentialKind: "pat",
    credentialId: "pat_1",
    surface: "gateway",
    appRowId: "app-chef",
    appSlug: "chef",
    toolName: "chef_list",
    risk: "read",
    decision: "allowed",
    outcome: "ok",
    durationMs: 12,
    resultBytes: 340,
    ...overrides,
  };
}

const ids = (page: { calls: { id: string }[] }) =>
  page.calls.map((row) => row.id);

describe("McpToolCallRepository.listForOrganization (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let other: string;
  let owner: string;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    acme = await seedOrganization(db, "acme");
    other = await seedOrganization(db, "other");
    owner = await seedMember(db, {
      organizationId: acme,
      role: "owner",
      email: "owner@acme.example",
    });
    await db.insert(apps).values({
      id: "app-chef",
      organizationId: acme,
      appSlug: "chef",
      name: "Chef",
      description: "",
    });
  });

  it("lists this organization's calls only, newest first, with the app's name and the caller's", async () => {
    const stranger = await seedMember(db, { organizationId: other });
    await db.insert(mcpToolCalls).values([
      call("c-old", {
        organizationId: acme,
        userId: owner,
        createdAt: new Date(AT - 2 * HOUR_MS),
      }),
      call("c-new", {
        organizationId: acme,
        userId: owner,
        createdAt: new Date(AT - HOUR_MS),
        credentialKind: "oauth",
        credentialId: "mcpc_1",
        clientName: "Claude Code",
        toolName: "chef_delete_recipe",
        risk: "destructive",
        decision: "blocked",
        reason: "needs_approval",
        outcome: "not_run",
        durationMs: null,
        resultBytes: null,
        argsDigest: "abc",
        requestId: "ray-1",
      }),
      // Another organization's call, newer than both: never listed here.
      call("c-other", { organizationId: other, userId: stranger }),
    ]);

    const page = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 50,
    });
    expect(page.nextBefore).toBeNull();
    expect(page.calls).toEqual([
      {
        id: "c-new",
        createdAt: AT - HOUR_MS,
        user: {
          id: owner,
          name: expect.any(String),
          email: "owner@acme.example",
        },
        credential: { kind: "oauth", clientName: "Claude Code" },
        app: { rowId: "app-chef", slug: "chef", name: "Chef", removed: false },
        tool: { name: "chef_delete_recipe", risk: "destructive" },
        decision: "blocked",
        reason: "needs_approval",
        outcome: "not_run",
        durationMs: null,
        resultBytes: null,
      },
      {
        id: "c-old",
        createdAt: AT - 2 * HOUR_MS,
        user: {
          id: owner,
          name: expect.any(String),
          email: "owner@acme.example",
        },
        credential: { kind: "pat", clientName: null },
        app: { rowId: "app-chef", slug: "chef", name: "Chef", removed: false },
        tool: { name: "chef_list", risk: "read" },
        decision: "allowed",
        reason: null,
        outcome: "ok",
        durationMs: 12,
        resultBytes: 340,
      },
    ]);
    // Nothing the table holds beyond the listed fields comes along.
    for (const row of page.calls) {
      expect(row).not.toHaveProperty("argsDigest");
      expect(row).not.toHaveProperty("requestId");
      expect(row).not.toHaveProperty("credentialId");
    }

    // The other organization sees its own call and nothing of Acme's.
    const theirs = await McpToolCallRepository.listForOrganization({
      organizationId: other,
      limit: 50,
    });
    expect(ids(theirs)).toEqual(["c-other"]);
    // An organization with no calls, or one that doesn't exist, gets nothing.
    expect(
      await McpToolCallRepository.listForOrganization({
        organizationId: "org-nobody",
        limit: 50,
      }),
    ).toEqual({ calls: [], nextBefore: null });
  });

  it("pages by keyset without gaps or repeats across rows with the same timestamp", async () => {
    const rows = [
      call("newer", {
        organizationId: acme,
        userId: owner,
        createdAt: new Date(AT + 1),
      }),
      ...Array.from({ length: 7 }, (_, index) =>
        call(`same-${index}`, { organizationId: acme, userId: owner }),
      ),
      call("older", {
        organizationId: acme,
        userId: owner,
        createdAt: new Date(AT - 1),
      }),
      // Noise from another organization at the very same instants.
      call("other-same", { organizationId: other, userId: owner }),
      call("other-newer", {
        organizationId: other,
        userId: owner,
        createdAt: new Date(AT + 1),
      }),
    ];
    await db.insert(mcpToolCalls).values(rows);

    const first = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 3,
    });
    expect(ids(first)).toEqual(["newer", "same-6", "same-5"]);
    expect(first.nextBefore).toEqual({ createdAt: AT, id: "same-5" });

    const second = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 3,
      before: first.nextBefore!,
    });
    expect(ids(second)).toEqual(["same-4", "same-3", "same-2"]);
    expect(second.nextBefore).toEqual({ createdAt: AT, id: "same-2" });

    const third = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 3,
      before: second.nextBefore!,
    });
    expect(ids(third)).toEqual(["same-1", "same-0", "older"]);
    // Exactly a page's worth was left: no next cursor.
    expect(third.nextBefore).toBeNull();

    // A cursor from one page's end finds nothing older than "older".
    const past = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 3,
      before: { createdAt: AT - 1, id: "older" },
    });
    expect(past).toEqual({ calls: [], nextBefore: null });

    // A page that ends exactly on the last row carries no cursor either.
    const whole = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 9,
    });
    expect(whole.calls).toHaveLength(9);
    expect(whole.nextBefore).toBeNull();
  });

  it("clamps the page size to 1..TOOL_CALL_PAGE_MAX", async () => {
    await db
      .insert(mcpToolCalls)
      .values([
        call("a", { organizationId: acme, userId: owner }),
        call("b", { organizationId: acme, userId: owner }),
      ]);
    const one = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 0,
    });
    expect(one.calls).toHaveLength(1);
    expect(one.nextBefore).toEqual({ createdAt: AT, id: "b" });
    const capped = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: TOOL_CALL_PAGE_MAX * 10,
    });
    expect(capped.calls).toHaveLength(2);
  });

  it("filters by app, user, decision, risk and time, together or alone", async () => {
    const member = await seedMember(db, { organizationId: acme });
    await db.insert(mcpToolCalls).values([
      call("chef-read", { organizationId: acme, userId: owner }),
      call("chef-write-blocked", {
        organizationId: acme,
        userId: owner,
        risk: "write",
        decision: "blocked",
        reason: "read_only_caller",
        outcome: "not_run",
      }),
      call("todo-member", {
        organizationId: acme,
        userId: member,
        appRowId: "app-todo",
        appSlug: "todo",
        toolName: "todo_list",
      }),
      call("chef-yesterday", {
        organizationId: acme,
        userId: owner,
        createdAt: new Date(AT - 30 * HOUR_MS),
      }),
      // The same app and user in another organization: never here.
      call("elsewhere", { organizationId: other, userId: owner }),
    ]);
    const list = (filters: Record<string, unknown>) =>
      McpToolCallRepository.listForOrganization({
        organizationId: acme,
        limit: 50,
        ...filters,
      }).then(ids);

    expect(await list({ appRowId: "app-chef" })).toEqual([
      "chef-write-blocked",
      "chef-read",
      "chef-yesterday",
    ]);
    expect(await list({ appRowId: "app-todo" })).toEqual(["todo-member"]);
    expect(await list({ userId: member })).toEqual(["todo-member"]);
    expect(await list({ decision: "blocked" })).toEqual(["chef-write-blocked"]);
    expect(await list({ decision: "allowed" })).toEqual([
      "todo-member",
      "chef-read",
      "chef-yesterday",
    ]);
    expect(await list({ risk: "write" })).toEqual(["chef-write-blocked"]);
    expect(await list({ since: new Date(AT - 24 * HOUR_MS) })).toEqual([
      "todo-member",
      "chef-write-blocked",
      "chef-read",
    ]);
    // `since` is inclusive.
    expect(await list({ since: new Date(AT) })).toHaveLength(3);
    expect(await list({ since: new Date(AT + 1) })).toEqual([]);
    expect(
      await list({
        appRowId: "app-chef",
        userId: owner,
        decision: "allowed",
        risk: "read",
        since: new Date(AT - 24 * HOUR_MS),
      }),
    ).toEqual(["chef-read"]);
    // A filter combined with the cursor.
    const firstChef = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 2,
      appRowId: "app-chef",
    });
    expect(ids(firstChef)).toEqual(["chef-write-blocked", "chef-read"]);
    const restChef = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 2,
      appRowId: "app-chef",
      before: firstChef.nextBefore!,
    });
    expect(ids(restChef)).toEqual(["chef-yesterday"]);
  });

  it("shows a former member by id with no name, and a removed app by its slug", async () => {
    // A member of another organization (in hosted mode everyone keeps a
    // personal one) who used to be a member here: their row stays, their
    // name and email do not come along.
    const former = await seedMember(db, {
      organizationId: other,
      email: "former@personal.example",
    });
    await db.insert(mcpToolCalls).values([
      call("by-former", {
        organizationId: acme,
        userId: former,
        appRowId: "app-gone",
        appSlug: "gone",
        toolName: "gone_list",
      }),
      call("by-owner", {
        organizationId: acme,
        userId: owner,
        createdAt: new Date(AT - 1),
      }),
      // A gateway-surface refusal of a tool that names no app.
      call("no-app", {
        organizationId: acme,
        userId: owner,
        createdAt: new Date(AT - 2),
        appRowId: null,
        appSlug: null,
        toolName: "nothing_here",
        risk: null,
        decision: "blocked",
        reason: "unknown_tool",
        outcome: "not_run",
      }),
    ]);

    const page = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 50,
    });
    expect(page.calls).toEqual([
      expect.objectContaining({
        id: "by-former",
        user: { id: former, name: null, email: null },
        app: { rowId: "app-gone", slug: "gone", name: null, removed: true },
      }),
      expect.objectContaining({
        id: "by-owner",
        user: {
          id: owner,
          name: expect.any(String),
          email: "owner@acme.example",
        },
      }),
      expect.objectContaining({
        id: "no-app",
        app: { rowId: null, slug: null, name: null, removed: false },
        tool: { name: "nothing_here", risk: null },
        decision: "blocked",
        reason: "unknown_tool",
      }),
    ]);

    // Their own organization's admins still see them by name.
    await db.insert(mcpToolCalls).values(
      call("at-home", {
        organizationId: other,
        userId: former,
        appRowId: null,
        appSlug: null,
      }),
    );
    const theirs = await McpToolCallRepository.listForOrganization({
      organizationId: other,
      limit: 50,
    });
    expect(theirs.calls).toEqual([
      expect.objectContaining({
        id: "at-home",
        user: expect.objectContaining({
          id: former,
          email: "former@personal.example",
        }),
      }),
    ]);
  });

  it("marks an app deleted through the product as removed, keeping its name", async () => {
    // Deleting leaves a tombstone: the row stays, status "deleted", name
    // and slug with it, until the slug is deployed again.
    await db.insert(apps).values({
      id: "app-x",
      organizationId: acme,
      appSlug: "x",
      name: "X App",
      description: "",
    });
    await db.insert(mcpToolCalls).values(
      call("on-x", {
        organizationId: acme,
        userId: owner,
        appRowId: "app-x",
        appSlug: "x",
        toolName: "x_list",
      }),
    );
    await AppRepository.tombstone({
      id: "app-x",
      organizationId: acme,
      status: "active",
    });
    expect(await AppRepository.findAllWithAccessCounts(acme)).toEqual([
      expect.objectContaining({ id: "app-chef" }),
    ]);

    const page = await McpToolCallRepository.listForOrganization({
      organizationId: acme,
      limit: 50,
    });
    expect(page.calls).toEqual([
      expect.objectContaining({
        id: "on-x",
        app: { rowId: "app-x", slug: "x", name: "X App", removed: true },
      }),
    ]);
  });

  it("lists the apps the organization's calls name, once each: live, shared, removed and gone", async () => {
    const platform = await seedOrganization(db, "platform");
    await db.insert(apps).values([
      {
        id: "app-shared",
        organizationId: platform,
        appSlug: "shared",
        name: "Shared App",
        description: "",
      },
      {
        id: "app-x",
        organizationId: acme,
        appSlug: "x",
        name: "X App",
        description: "",
      },
    ]);
    await AppRepository.tombstone({
      id: "app-x",
      organizationId: acme,
      status: "active",
    });
    const stranger = await seedMember(db, { organizationId: other });
    await db.insert(mcpToolCalls).values([
      call("chef-1", { organizationId: acme, userId: owner }),
      call("chef-2", {
        organizationId: acme,
        userId: owner,
        createdAt: new Date(AT - 1),
      }),
      call("shared-1", {
        organizationId: acme,
        userId: owner,
        appRowId: "app-shared",
        appSlug: "shared",
      }),
      call("x-1", {
        organizationId: acme,
        userId: owner,
        appRowId: "app-x",
        appSlug: "x",
      }),
      call("gone-1", {
        organizationId: acme,
        userId: owner,
        appRowId: "app-gone",
        appSlug: "gone",
      }),
      call("no-app", {
        organizationId: acme,
        userId: owner,
        appRowId: null,
        appSlug: null,
        toolName: "nothing_here",
        decision: "blocked",
        reason: "unknown_tool",
        outcome: "not_run",
      }),
      // Another organization's call on the shared app: not this list's.
      call("elsewhere", {
        organizationId: other,
        userId: stranger,
        appRowId: "app-other",
        appSlug: "other-app",
      }),
    ]);

    const listed = await McpToolCallRepository.listAppsWithCalls(acme);
    expect(listed.sort((a, b) => a.rowId.localeCompare(b.rowId))).toEqual([
      { rowId: "app-chef", slug: "chef", name: "Chef", removed: false },
      { rowId: "app-gone", slug: "gone", name: null, removed: true },
      {
        rowId: "app-shared",
        slug: "shared",
        name: "Shared App",
        removed: false,
      },
      { rowId: "app-x", slug: "x", name: "X App", removed: true },
    ]);
    expect(await McpToolCallRepository.listAppsWithCalls(other)).toEqual([
      { rowId: "app-other", slug: "other-app", name: null, removed: true },
    ]);
  });
});
