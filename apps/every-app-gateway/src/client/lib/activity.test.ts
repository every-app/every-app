import { describe, expect, it, vi } from "vitest";
import type { ToolCallsPage } from "@/types/activity";
import {
  toolCallAppLabel,
  toolCallsInfiniteQuery,
  windowStart,
} from "./activity";

const NOON = Date.parse("2026-10-24T12:00:00.000Z");
const DAY_MS = 86_400_000;

const emptyPage: ToolCallsPage = { calls: [], nextBefore: null };

describe("windowStart", () => {
  it("reaches back a day, a week or thirty days, and nowhere for all time", () => {
    expect(windowStart("24h", NOON)).toBe(NOON - DAY_MS);
    expect(windowStart("7d", NOON)).toBe(NOON - 7 * DAY_MS);
    expect(windowStart("30d", NOON)).toBe(NOON - 30 * DAY_MS);
    expect(windowStart("all", NOON)).toBeUndefined();
  });
});

describe("toolCallsInfiniteQuery", () => {
  const filters = {
    appRowId: undefined,
    decision: undefined,
    risk: undefined,
    range: "24h" as const,
    limit: 50,
  };

  it("takes the window from the clock on the first page and keeps it for the next ones", async () => {
    let clock = NOON;
    const fetchPage = vi.fn().mockResolvedValue(emptyPage);
    const query = toolCallsInfiniteQuery(filters, fetchPage, () => clock);

    await query.queryFn({ pageParam: null });
    clock += 3_600_000;
    await query.queryFn({ pageParam: { createdAt: NOON - 1, id: "c-50" } });

    expect(fetchPage.mock.calls.map(([request]) => request)).toEqual([
      {
        appRowId: undefined,
        decision: undefined,
        risk: undefined,
        limit: 50,
        since: NOON - DAY_MS,
        before: undefined,
      },
      {
        appRowId: undefined,
        decision: undefined,
        risk: undefined,
        limit: 50,
        since: NOON - DAY_MS,
        before: { createdAt: NOON - 1, id: "c-50" },
      },
    ]);
  });

  it("takes the window afresh when the first page loads again, so a refetch hours later still means the last 24 h", async () => {
    let clock = NOON;
    const fetchPage = vi.fn().mockResolvedValue(emptyPage);
    const query = toolCallsInfiniteQuery(filters, fetchPage, () => clock);

    await query.queryFn({ pageParam: null });
    clock = NOON + 3 * 3_600_000;
    await query.queryFn({ pageParam: null });

    expect(fetchPage.mock.calls.map(([request]) => request.since)).toEqual([
      NOON - DAY_MS,
      NOON + 3 * 3_600_000 - DAY_MS,
    ]);
    // The key names the range, never the clock, so the refetch hits the same entry.
    expect(query.queryKey).toEqual(["admin", "toolCalls", filters]);
  });

  it("sends no start for all time, and the cursor from the page before", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      calls: [],
      nextBefore: { createdAt: NOON, id: "c-1" },
    });
    const query = toolCallsInfiniteQuery(
      { ...filters, range: "all", appRowId: "app-1", decision: "blocked" },
      fetchPage,
      () => NOON,
    );
    const page = await query.queryFn({ pageParam: null });
    expect(fetchPage).toHaveBeenCalledWith({
      appRowId: "app-1",
      decision: "blocked",
      risk: undefined,
      limit: 50,
      since: undefined,
      before: undefined,
    });
    expect(query.getNextPageParam(page)).toEqual({
      createdAt: NOON,
      id: "c-1",
    });
    expect(query.getNextPageParam(emptyPage)).toBeNull();
  });
});

describe("toolCallAppLabel", () => {
  it("names the app, falls back to its slug, and says when it is removed", () => {
    expect(
      toolCallAppLabel({
        rowId: "a",
        slug: "chef",
        name: "Chef",
        removed: false,
      }),
    ).toBe("Chef");
    expect(
      toolCallAppLabel({
        rowId: "a",
        slug: "chef",
        name: "Chef",
        removed: true,
      }),
    ).toBe("Chef (removed)");
    expect(
      toolCallAppLabel({ rowId: "a", slug: "gone", name: null, removed: true }),
    ).toBe("gone (removed)");
    expect(
      toolCallAppLabel({ rowId: "a", slug: null, name: null, removed: true }),
    ).toBe("a (removed)");
  });
});
