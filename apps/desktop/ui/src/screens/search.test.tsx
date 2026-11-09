import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../types";
import { SearchScreen } from "./SearchScreen";

afterEach(cleanup);

const row = {
  startsAt: "2026-11-02T15:00:00.000Z",
  endsAt: null,
  status: "done",
  visibility: "private",
  ownerUserId: "u",
  ownerEmail: "ben@every.to",
  attendeeCount: 2,
  mine: true,
} as const;

const results: SearchResult[] = [
  {
    meeting: { ...row, id: "m1", title: "Northwind pricing" },
    field: "transcript",
    snippet: {
      text: "…a number per seat for forty…",
      ranges: [{ start: 14, end: 18 }],
    },
  },
  {
    meeting: { ...row, id: "m2", title: "Pricing review" },
    field: "title",
    snippet: { text: "Pricing review", ranges: [{ start: 0, end: 7 }] },
  },
];

describe("SearchScreen", () => {
  it("shows each result with its field and the matched words marked, as text", () => {
    const onOpen = vi.fn();
    render(
      <SearchScreen
        query="seat"
        onQueryChange={() => {}}
        results={{ status: "ready", data: { results, hasMore: false } }}
        onOpen={onOpen}
      />,
    );
    const marks = Array.from(document.querySelectorAll("mark")).map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(["seat", "Pricing"]);
    // Badges name where it matched; a title match highlights the title instead.
    expect(screen.getByText("Transcript")).toBeTruthy();
    expect(screen.queryByText("Title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Northwind pricing/ }));
    expect(onOpen).toHaveBeenCalledWith(results[0]);
  });

  it("never renders snippet markup as HTML", () => {
    const evil: SearchResult = {
      ...results[0]!,
      snippet: { text: "<img src=x onerror=alert(1)> **bold**", ranges: [] },
    };
    render(
      <SearchScreen
        query="x"
        onQueryChange={() => {}}
        results={{ status: "ready", data: { results: [evil], hasMore: false } }}
        onOpen={() => {}}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    expect(
      screen.getByText("<img src=x onerror=alert(1)> **bold**"),
    ).toBeTruthy();
  });

  it("has idle, no-results and load-more states, and Escape clears", () => {
    const onQueryChange = vi.fn();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <SearchScreen
        query=""
        onQueryChange={onQueryChange}
        results={{ status: "idle" }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Search your meetings")).toBeTruthy();
    rerender(
      <SearchScreen
        query="zzz"
        onQueryChange={onQueryChange}
        results={{ status: "ready", data: { results: [], hasMore: false } }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("No meetings match “zzz”")).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("searchbox", { name: "Search meetings" }),
      { key: "Escape" },
    );
    expect(onQueryChange).toHaveBeenCalledWith("");
    rerender(
      <SearchScreen
        query="p"
        onQueryChange={onQueryChange}
        results={{ status: "ready", data: { results, hasMore: true } }}
        onOpen={() => {}}
        onLoadMore={onLoadMore}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More results" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("says search needs a connection when offline", () => {
    render(
      <SearchScreen
        query="pricing"
        onQueryChange={() => {}}
        results={{ status: "offline" }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByText(/Search needs a connection/)).toBeTruthy();
  });
});
