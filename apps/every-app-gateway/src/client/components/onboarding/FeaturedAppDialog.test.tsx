// @vitest-environment happy-dom
/**
 * One of the four apps before it is installed: an owner or admin gets the
 * install command, a member is told who installs it; both see what the
 * app needs and where its source is.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FEATURED_APPS } from "@/client/lib/featuredApps";
import { FeaturedAppDialog } from "./FeaturedAppDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const openseo = FEATURED_APPS[0]!;

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

function render(canRun: boolean) {
  const onClose = vi.fn();
  act(() => {
    root.render(
      <FeaturedAppDialog app={openseo} canRun={canRun} onClose={onClose} />,
    );
  });
  return onClose;
}

it("gives an owner or admin the install command and what to have ready", () => {
  render(true);
  const text = document.body.textContent ?? "";
  expect(text).toContain("OpenSEO is open source");
  expect(text).toContain(`pnpm everyapp install ${openseo.repo}`);
  for (const need of openseo.needs) expect(text).toContain(need);
  expect(
    document.body.querySelector(`a[href="${openseo.repo}"]`),
  ).not.toBeNull();
  expect(text).not.toContain("Ask an owner or admin");
});

it("tells a member who installs it, with no command", () => {
  render(false);
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("pnpm");
  expect(text).toContain("Ask an owner or admin to install it.");
  for (const need of openseo.needs) expect(text).toContain(need);
  expect(
    document.body.querySelector(`a[href="${openseo.repo}"]`),
  ).not.toBeNull();
});
