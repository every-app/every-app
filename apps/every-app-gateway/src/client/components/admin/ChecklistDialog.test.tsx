// @vitest-environment happy-dom
/**
 * The checklist dialog rendered for real: while its list loads or has
 * failed it counts nothing, and once the list is in it counts what is
 * checked.
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

function render(state: { isLoading?: boolean; isError?: boolean }) {
  act(() =>
    root.render(
      <ChecklistDialog
        title="Members of Sales"
        description="Everyone checked can open the apps granted to this group."
        noun="user"
        items={state.isLoading || state.isError ? [] : ITEMS}
        initialSelectedIds={state.isLoading || state.isError ? [] : ["a"]}
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
