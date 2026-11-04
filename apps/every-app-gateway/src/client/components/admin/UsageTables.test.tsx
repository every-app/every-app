// @vitest-environment happy-dom
/**
 * The By app table's Monthly cap cell rendered for real, one row per
 * state: nothing binds, the workspace default, the app's own cap, "no
 * cap" against a default, a paused app, a past month, and a deleted app.
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
  options: { isCurrentMonth?: boolean; hasDefault?: boolean } = {},
) {
  act(() =>
    root.render(
      <UsageByAppTable
        rows={rows}
        isLoading={false}
        isCurrentMonth={options.isCurrentMonth ?? true}
        hasDefault={options.hasDefault ?? false}
        onSetCap={onSetCap}
      />,
    ),
  );
}

/**
 * The cells of the Monthly cap column, as text, in row order; the
 * progress bar's hidden presentation span is left out.
 */
function capCells(): string[] {
  return [...container.querySelectorAll("tbody tr")].map((tr) => {
    const cells = tr.querySelectorAll("td");
    const cell = cells[cells.length - 1]?.cloneNode(true) as
      | HTMLElement
      | undefined;
    cell
      ?.querySelectorAll('[role="presentation"]')
      .forEach((node) => node.remove());
    return cell?.textContent?.trim() ?? "";
  });
}

function capButton(label: string, app: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label} monthly cap for ${app}"]`,
  );
}

it("reads Unlimited with Set cap when nothing binds and there is no default", () => {
  render([row("Notes")]);
  expect(capCells()).toEqual(["UnlimitedSet cap"]);
  expect(capButton("Set", "Notes")).not.toBeNull();
  expect(container.querySelector('[data-slot="progress"]')).toBeNull();
});

it("shows the default's progress with its source, and Edit", () => {
  render(
    [
      row("Notes", {
        effectiveMonthlyCostCapMicros: 20_000_000,
        costCapSource: "default",
      }),
    ],
    { hasDefault: true },
  );
  expect(capCells()).toEqual(["$4.20 of $20.00 · defaultEdit"]);
  expect(capButton("Edit", "Notes")).not.toBeNull();
  const bar = container.querySelector('[data-slot="progress"]');
  expect(bar?.getAttribute("aria-label")).toBe(
    "Notes: $4.20 of $20.00 of provider-reported cost this month",
  );
});

it("shows the app's own cap as before, without a source", () => {
  render(
    [
      row("Notes", {
        monthlyCostCapMicros: 50_000_000,
        effectiveMonthlyCostCapMicros: 50_000_000,
        costCapSource: "app",
      }),
    ],
    { hasDefault: true },
  );
  expect(capCells()).toEqual(["$4.20 of $50.00Edit"]);
});

it("reads No cap with Edit for an app told to ignore the default", () => {
  render([row("Notes", { capUnlimited: true })], { hasDefault: true });
  expect(capCells()).toEqual(["No capEdit"]);
  expect(capButton("Edit", "Notes")).not.toBeNull();
});

it("reads Unlimited again for a leftover no-cap row once the default is gone", () => {
  render([row("Notes", { capUnlimited: true })], { hasDefault: false });
  expect(capCells()).toEqual(["UnlimitedSet cap"]);
});

it("says Paused in red with a red bar and offers Raise, which opens the dialog for that row", () => {
  const paused = row("Notes", {
    costMicros: 20_500_000,
    effectiveMonthlyCostCapMicros: 20_000_000,
    costCapSource: "default",
    paused: true,
  });
  render([paused], { hasDefault: true });
  expect(capCells()).toEqual(["Paused · $20.50 of $20.00Raise"]);
  const line = container.querySelector("tbody td:last-child span");
  expect(line?.className).toContain("text-destructive");
  expect(
    container.querySelector('[data-slot="progress-indicator"]')?.className,
  ).toContain("bg-destructive");
  const raise = capButton("Raise", "Notes");
  expect(raise).not.toBeNull();
  act(() => raise!.click());
  expect(onSetCap).toHaveBeenCalledWith(paused);
});

it("shows a past month's cap alone, its source kept, with no bar", () => {
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
    { isCurrentMonth: false, hasDefault: true },
  );
  expect(capCells()).toEqual(["$20.00 · defaultEdit", "$12.50Edit"]);
  expect(container.querySelector('[data-slot="progress"]')).toBeNull();
});

it("gives a deleted app neither a cap nor a button", () => {
  render([row("Gone", { callable: false, appSlug: "gone" })]);
  expect(capCells()).toEqual([""]);
  expect(container.querySelector("tbody button")).toBeNull();
});

it("reads Not metered with no button for an MCP server added by URL, even under a default", () => {
  render([row("Treg", { metered: false })], { hasDefault: true });
  expect(capCells()).toEqual(["Not metered"]);
  expect(container.querySelector("tbody button")).toBeNull();
});
