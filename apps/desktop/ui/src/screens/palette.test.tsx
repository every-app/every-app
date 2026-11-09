import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../types";
import { SearchPalette } from "./SearchPalette";

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
    field: "notes",
    snippet: { text: "…per-seat pricing…", ranges: [{ start: 10, end: 17 }] },
  },
  {
    meeting: { ...row, id: "m2", title: "Acme renewal" },
    field: "jottings",
    snippet: { text: "- pricing tiers", ranges: [{ start: 2, end: 9 }] },
  },
];

function setup(extra: Partial<Parameters<typeof SearchPalette>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    query: "pric",
    onQueryChange: vi.fn(),
    results: { status: "ready", data: { results, hasMore: true } } as const,
    onOpen: vi.fn(),
    onShowAll: vi.fn(),
    ...extra,
  };
  render(<SearchPalette {...props} />);
  return {
    ...props,
    box: screen.getByRole("combobox", { name: "Search meetings" }),
  };
}

describe("SearchPalette (⌘K)", () => {
  it("lists results with badges and highlighted snippets, as text", () => {
    setup();
    expect(screen.getAllByRole("option")).toHaveLength(3); // two results + Show all
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText("Jottings")).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll("mark")).map((m) => m.textContent),
    ).toEqual(["pricing", "pricing"]);
  });

  it("moves with the arrow keys and opens the active result on Enter", () => {
    const { box, onOpen } = setup();
    const options = () => screen.getAllByRole("option");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(results[1]);
  });

  it("wraps around, and Enter on Show all opens the full page", () => {
    const { box, onShowAll } = setup();
    fireEvent.keyDown(box, { key: "ArrowUp" }); // from the first, wraps to Show all
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onShowAll).toHaveBeenCalledOnce();
  });

  it("closes on Esc", () => {
    const { box, onOpenChange } = setup();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("explains idle, offline and no matches", () => {
    setup({ results: { status: "idle" } });
    expect(screen.getByText(/Type to search/)).toBeTruthy();
    cleanup();
    setup({
      results: { status: "offline", message: "Search needs a connection." },
    });
    expect(screen.getByText("Search needs a connection.")).toBeTruthy();
    cleanup();
    setup({
      query: "zzz",
      results: { status: "ready", data: { results: [], hasMore: false } },
    });
    expect(screen.getByText("No meetings match “zzz”.")).toBeTruthy();
  });
});
