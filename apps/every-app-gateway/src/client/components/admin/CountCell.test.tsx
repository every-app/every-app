// @vitest-environment happy-dom
/**
 * The count cell's accessible name: the visible count first, so assistive
 * tech hears the column's value and voice control can say what it sees,
 * then what the click opens.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountCell } from "./CountCell";

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

function render(count: number, onClick = () => undefined): HTMLButtonElement {
  act(() =>
    root.render(
      <CountCell
        count={count}
        noun="user"
        aria-label="Manage access to Notes"
        onClick={onClick}
      />,
    ),
  );
  return container.querySelector("button")!;
}

describe("CountCell", () => {
  it("names itself by its visible count, then what opens", () => {
    const cell = render(3);
    expect(cell.textContent).toBe("3 users");
    expect(cell.getAttribute("aria-label")).toBe(
      "3 users. Manage access to Notes",
    );
    expect(cell.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("keeps the noun singular for one, in the name too", () => {
    const cell = render(1);
    expect(cell.textContent).toBe("1 user");
    expect(cell.getAttribute("aria-label")).toBe(
      "1 user. Manage access to Notes",
    );
  });

  it("opens what it counts on click", () => {
    const onClick = vi.fn();
    const cell = render(0, onClick);
    act(() => {
      cell.click();
    });
    expect(onClick).toHaveBeenCalledOnce();
  });
});
