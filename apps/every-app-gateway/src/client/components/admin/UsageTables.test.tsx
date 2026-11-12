// @vitest-environment happy-dom
/**
 * The By app table's Monthly cap cell rendered for real, one row per
 * state: no cap, the workspace default, the app's own cap, a paused app, a
 * past month, a deleted app and an unmetered one. The row's menu opens the
 * cap dialog.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageAppRow } from "@/types/usage";
import { UsageByAppTable } from "./UsageTables";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onSetCap: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onSetCap = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function row(name: string, overrides: Partial<UsageAppRow> = {}): UsageAppRow {
  return {
    appRowId: `row-${name.toLowerCase()}`,
    name,
    appSlug: name.toLowerCase(),
    calls: 240,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 4_200_000,
    toolCalls: 0,
    capUnlimited: false,
    monthlyCostCapMicros: null,
    effectiveMonthlyCostCapMicros: null,
    costCapSource: null,
    paused: false,
    callable: true,
    metered: true,
    ...overrides,
  };
}

function render(
  rows: UsageAppRow[],
  options: { isCurrentMonth?: boolean } = {},
) {
  act(() =>
    root.render(
      <UsageByAppTable
        rows={rows}
        isLoading={false}
        isCurrentMonth={options.isCurrentMonth ?? true}
        onSetCap={onSetCap}
      />,
    ),
  );
}

/**
 * The cells of the Monthly cap column (the one before the menu), as text, in
 * row order; the progress bar's hidden presentation span is left out.
 */
function capCells(): string[] {
  return [...container.querySelectorAll("tbody tr")].map((tr) => {
    const cells = tr.querySelectorAll("td");
    const cell = cells[cells.length - 2]?.cloneNode(true) as
      | HTMLElement
      | undefined;
    cell
      ?.querySelectorAll('[role="presentation"]')
      .forEach((node) => node.remove());
    return cell?.textContent?.trim() ?? "";
  });
}

/** The row's menu button, in the table (the phone's rows repeat it). */
function menu(app: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `table button[aria-label="Actions for ${app}"]`,
  );
}

/** The table's progress bars (the phone's rows repeat them). */
const bars = () => container.querySelectorAll('table [data-slot="progress"]');

it("reads No cap, with no bar, when nothing binds", () => {
  render([row("Notes")]);
  expect(capCells()).toEqual(["No cap"]);
  expect(bars()).toHaveLength(0);
});

it("reads No cap the same way for an app told to ignore the default", () => {
  render([row("Notes", { capUnlimited: true })]);
  expect(capCells()).toEqual(["No cap"]);
});

it("shows the default's progress, and a bar", () => {
  render([
    row("Notes", {
      effectiveMonthlyCostCapMicros: 20_000_000,
      costCapSource: "default",
    }),
  ]);
  expect(capCells()).toEqual(["$4.20 of $20.00"]);
  expect(bars()[0]?.getAttribute("aria-label")).toBe(
    "Notes: $4.20 of $20.00 of provider-reported cost this month",
  );
});

it("shows the app's own cap the same way", () => {
  render([
    row("Notes", {
      monthlyCostCapMicros: 50_000_000,
      effectiveMonthlyCostCapMicros: 50_000_000,
      costCapSource: "app",
    }),
  ]);
  expect(capCells()).toEqual(["$4.20 of $50.00"]);
  expect(bars()).toHaveLength(1);
});

it("says paused in red with a red bar", () => {
  render([
    row("Notes", {
      costMicros: 20_500_000,
      effectiveMonthlyCostCapMicros: 20_000_000,
      costCapSource: "default",
      paused: true,
    }),
  ]);
  expect(capCells()).toEqual(["$20.50 of $20.00"]);
  expect(container.querySelector("tbody .text-destructive")?.textContent).toBe(
    "$20.50 of $20.00",
  );
  expect(
    container.querySelector('[data-slot="progress-indicator"]')?.className,
  ).toContain("bg-destructive");
});

it("opens the cap dialog for the row from its menu", () => {
  const notes = row("Notes");
  render([notes, row("Todo")]);
  act(() => menu("Notes")!.click());
  const items = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ];
  expect(items.map((item) => item.textContent?.trim())).toEqual([
    "Edit monthly cap",
  ]);
  act(() => items[0]!.click());
  expect(onSetCap).toHaveBeenCalledWith(notes);
});

it("shows a past month's cap alone, with no bar", () => {
  render(
    [
      row("Notes", {
        effectiveMonthlyCostCapMicros: 20_000_000,
        costCapSource: "default",
      }),
      row("Todo", {
        monthlyCostCapMicros: 12_500_000,
        effectiveMonthlyCostCapMicros: 12_500_000,
        costCapSource: "app",
      }),
    ],
    { isCurrentMonth: false },
  );
  expect(capCells()).toEqual(["$20.00", "$12.50"]);
  expect(bars()).toHaveLength(0);
});

it("gives a deleted app neither a cap nor a menu", () => {
  render([row("Gone", { callable: false, appSlug: "gone" })]);
  expect(capCells()).toEqual([""]);
  expect(container.querySelector("tbody button")).toBeNull();
});

it("reads Not metered with no menu for an MCP server added by URL", () => {
  render([row("Treg", { metered: false })]);
  expect(capCells()).toEqual(["Not metered"]);
  expect(container.querySelector("tbody button")).toBeNull();
});
