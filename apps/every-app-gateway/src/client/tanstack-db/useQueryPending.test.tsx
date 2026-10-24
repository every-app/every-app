// @vitest-environment happy-dom
/**
 * A reset query reads as pending until it answers again, so a page shows its
 * skeleton rather than the rows its collection kept.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { queryClient } from "./queryClient";
import { useQueryPending } from "./useQueryPending";

const KEY = ["test", "pending"];

function Harness() {
  return <output>{useQueryPending(KEY) ? "pending" : "loaded"}</output>;
}

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
  queryClient.removeQueries({ queryKey: KEY });
});

// The cache's notifications reach the hook on the next tick.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("is pending before the query exists, loaded with data, pending after a reset", async () => {
  act(() => root.render(<Harness />));
  expect(container.textContent).toBe("pending");

  await act(async () => {
    queryClient.setQueryData(KEY, [{ id: 1 }]);
    await tick();
  });
  expect(container.textContent).toBe("loaded");

  await act(async () => {
    queryClient.getQueryCache().find({ queryKey: KEY })?.reset();
    await tick();
  });
  expect(container.textContent).toBe("pending");
});
