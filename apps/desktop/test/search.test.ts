import { describe, expect, it } from "vitest";
import { parseTab, searchable, tabFor } from "../src/renderer/src/search";

describe("search", () => {
  it("only sends a query with a letter or digit in it", () => {
    expect(searchable("pricing")).toBe(true);
    expect(searchable("SOC2")).toBe(true);
    expect(searchable("café")).toBe(true);
    expect(searchable("会議")).toBe(true);
    expect(searchable("?!—")).toBe(false);
    expect(searchable("   ")).toBe(false);
  });

  it("opens a result on the tab where it matched", () => {
    expect(tabFor("transcript")).toBe("transcript");
    expect(tabFor("jottings")).toBe("jottings");
    expect(tabFor("notes")).toBeUndefined();
    expect(tabFor("title")).toBeUndefined();
    expect(parseTab("transcript")).toBe("transcript");
    expect(parseTab("admin")).toBeUndefined();
    expect(parseTab(undefined)).toBeUndefined();
  });
});

describe("what search shows", () => {
  it("is idle, offline, signed out, loading, failed or results", async () => {
    const { searchState, OFFLINE_TEXT, SIGNIN_TEXT } = await import("../src/renderer/src/search");
    const base = { settled: "pricing", connection: "online" as const, pending: false, error: null, results: [], hasMore: false };
    expect(searchState({ ...base, settled: "" })).toEqual({ status: "idle" });
    expect(searchState({ ...base, connection: "offline" })).toEqual({ status: "offline", message: OFFLINE_TEXT });
    expect(searchState({ ...base, connection: "signin-needed" })).toEqual({ status: "offline", message: SIGNIN_TEXT });
    expect(searchState({ ...base, settled: "?!" })).toEqual({ status: "ready", data: { results: [], hasMore: false } });
    expect(searchState({ ...base, pending: true })).toEqual({ status: "loading" });
    expect(searchState({ ...base, error: "Scribe answered HTTP 500." })).toEqual({ status: "error", message: "Scribe answered HTTP 500." });
    expect(searchState({ ...base, hasMore: true })).toEqual({ status: "ready", data: { results: [], hasMore: true } });
  });
});
