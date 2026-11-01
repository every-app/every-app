// @vitest-environment happy-dom
/**
 * The gallery rendered for real (React in a DOM): five cards, each a
 * button that opens a dialog, nothing that installs.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FEATURED_APPS } from "@/client/lib/featuredApps";
import { AppGallery } from "./AppGallery";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onPickApp: ReturnType<typeof vi.fn>;
let onBuild: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onPickApp = vi.fn();
  onBuild = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<AppGallery onPickApp={onPickApp} onBuild={onBuild} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows the four apps and Build your own, each as a dialog button", () => {
  const buttons = Array.from(container.querySelectorAll("button"));
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    ...FEATURED_APPS.map((app) => `Install ${app.name}`),
    "Build your own",
  ]);
  expect(
    buttons.every(
      (button) => button.getAttribute("aria-haspopup") === "dialog",
    ),
  ).toBe(true);
  for (const app of FEATURED_APPS) {
    expect(container.textContent).toContain(app.name);
    expect(container.textContent).toContain(app.line);
    expect(
      container.querySelector(`img[src="/apps/${app.id}.svg"]`),
    ).not.toBeNull();
  }
  // No command on the cards: the dialog carries it.
  expect(container.textContent).not.toContain("pnpm");
});

it("opens the app behind a card, or Build your own", () => {
  const [first] = Array.from(container.querySelectorAll("button"));
  act(() => first!.click());
  expect(onPickApp).toHaveBeenCalledWith(FEATURED_APPS[0]);
  expect(onBuild).not.toHaveBeenCalled();

  const build = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Build your own"]',
  );
  act(() => build!.click());
  expect(onBuild).toHaveBeenCalledTimes(1);
});
