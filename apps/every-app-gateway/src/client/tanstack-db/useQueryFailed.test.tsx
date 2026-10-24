// @vitest-environment happy-dom
/**
 * A query collection reports no error through useLiveQuery; the pages read
 * the query's own state instead, and re-render when it changes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { queryClient } from "./queryClient";
import { useQueryFailed } from "./useQueryFailed";

const KEY = ["test", "failed"];

function Harness() {
  return <output>{useQueryFailed(KEY) ? "failed" : "fine"}</output>;
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

it("follows the query from fine to failed and back", () => {
  act(() => root.render(<Harness />));
  expect(container.textContent).toBe("fine");

  const query = queryClient.getQueryCache().build(queryClient, {
    queryKey: KEY,
  });
  act(() => {
    query.setState({ status: "error", error: new Error("Failed to fetch") });
  });
  expect(container.textContent).toBe("failed");

  act(() => {
    query.setState({ status: "success", error: null });
  });
  expect(container.textContent).toBe("fine");
});
