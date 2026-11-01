// @vitest-environment happy-dom
/**
 * The checklist dialog rendered for real: while its list loads or has
 * failed it counts nothing; once the list is in it counts what is checked,
 * lists what was checked when it opened first and keeps that order while
 * toggling, and says how many rows sit below the fold of its scroll box,
 * from the box's real scroll state.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ChecklistDialog } from "./ChecklistDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const ITEMS = [
  { id: "a", label: "Alex Admin", detail: "admin@example.com" },
  { id: "b", label: "sam@example.com" },
];

function render(state: {
  isLoading?: boolean;
  isError?: boolean;
  items?: { id: string; label: string; detail?: string }[];
  selected?: string[];
}) {
  const out = state.isLoading || state.isError;
  act(() =>
    root.render(
      <ChecklistDialog
        title="Members of Sales"
        description="Everyone checked can open the apps granted to this group."
        noun="user"
        items={out ? [] : (state.items ?? ITEMS)}
        initialSelectedIds={out ? [] : (state.selected ?? ["a"])}
        isLoading={state.isLoading ?? false}
        isError={state.isError ?? false}
        isRefetching={false}
        onRetry={() => undefined}
        onSave={async () => undefined}
        onClose={() => undefined}
        emptyText="No users in this organization yet."
      />,
    ),
  );
  // The dialog renders in a portal, so read the whole document.
  return document.body.textContent ?? "";
}

/** The rows' labels, top to bottom. */
function rows(): string[] {
  return [...document.body.querySelectorAll("li")].map(
    (row) => row.querySelector("span.font-medium")?.textContent ?? "",
  );
}

/** The row's checkbox input (a label click bubbles and toggles twice). */
function checkboxInput(label: string): HTMLInputElement {
  const row = [...document.body.querySelectorAll("li")].find((element) =>
    element.textContent?.includes(label),
  );
  if (!row) throw new Error(`no row for ${label}`);
  return row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function scrollBox(): HTMLElement {
  return document.body.querySelector<HTMLElement>('[data-slot="scroll-box"]')!;
}

/** Layout happy-dom does not do: the box's size and where each row sits. */
function layOut(
  box: HTMLElement,
  sizes: { rowHeight: number; visible: number },
) {
  const rowElements = box.querySelectorAll("li");
  const define = (element: Element, props: Record<string, number>) => {
    for (const [name, value] of Object.entries(props)) {
      Object.defineProperty(element, name, {
        configurable: true,
        writable: true,
        value,
      });
    }
  };
  define(box, {
    scrollTop: 0,
    clientHeight: sizes.rowHeight * sizes.visible,
    scrollHeight: sizes.rowHeight * rowElements.length,
  });
  rowElements.forEach((row, index) =>
    define(row, {
      offsetTop: index * sizes.rowHeight,
      offsetHeight: sizes.rowHeight,
    }),
  );
}

function scrollTo(box: HTMLElement, top: number) {
  act(() => {
    (box as unknown as { scrollTop: number }).scrollTop = top;
    box.dispatchEvent(new Event("scroll"));
  });
}

it("counts nothing while the list loads", () => {
  const text = render({ isLoading: true });
  expect(text).toContain("Members of Sales");
  expect(text).not.toContain("selected");
});

it("shows the failure alone, with no count under it", () => {
  const text = render({ isError: true });
  expect(text).toContain("Failed to load users.");
  expect(text).toContain("Try again");
  expect(text).not.toContain("selected");
});

it("counts what is checked once the list is in", () => {
  const text = render({});
  expect(text).toContain("Alex Admin");
  expect(text).toContain("admin@example.com");
  expect(text).toContain("1 of 2 users selected");
});

it("lists what was checked when it opened first, and holds that order while toggling", () => {
  render({ selected: ["b"] });
  expect(rows()).toEqual(["sam@example.com", "Alex Admin"]);

  // Checking Alex marks the row as adding; it does not move up.
  act(() => checkboxInput("Alex Admin").click());
  expect(document.body.textContent).toContain("2 of 2 users selected");
  expect(rows()).toEqual(["sam@example.com", "Alex Admin"]);

  // Unchecking Sam marks the row as removing; it does not move down.
  act(() => checkboxInput("sam@example.com").click());
  expect(document.body.textContent).toContain("1 of 2 users selected");
  expect(rows()).toEqual(["sam@example.com", "Alex Admin"]);
});

it("says how many rows sit below the fold, from the real scroll state", () => {
  const items = Array.from({ length: 9 }, (_, index) => ({
    id: `app-${index}`,
    label: `App ${index}`,
  }));
  render({ items, selected: [] });
  // Everything fits (happy-dom lays nothing out): no cue, never a static mask.
  expect(document.body.textContent).not.toContain("more below");

  // Five of nine rows fit exactly, so no sixth row peeks.
  const box = scrollBox();
  layOut(box, { rowHeight: 57, visible: 5 });
  scrollTo(box, 0);
  expect(document.body.textContent).toContain("4 more below");

  // Half a row further: the sixth row shows mostly, three are still under.
  scrollTo(box, 40);
  expect(document.body.textContent).toContain("3 more below");

  // At the bottom the cue goes.
  scrollTo(box, 57 * 4);
  expect(document.body.textContent).not.toContain("more below");
});
