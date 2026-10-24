// @vitest-environment happy-dom
/**
 * The "Use it from your agent" dialog rendered for real (React in a DOM):
 * it shows this Gateway's own MCP address with a copy button, the app's
 * tool prefix, the provider's example sentence and the two docs links,
 * and closes from its footer.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CONNECT_AI_DOCS_URL,
  MCP_APPS_DOCS_URL,
  McpAppDialog,
} from "./McpAppDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onClose = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const dialog = () => document.body.querySelector('[role="dialog"]');
const text = () => dialog()?.textContent ?? "";

it("says where the app is reached and what to say, with the docs to go on with", () => {
  act(() =>
    root.render(
      <McpAppDialog name="DataForSEO" appId="dataforseo" onClose={onClose} />,
    ),
  );
  expect(text()).toContain("Use DataForSEO from your agent");
  expect(text()).toContain("DataForSEO has no page.");
  // The address is this origin's, read on the client.
  expect(dialog()?.querySelector("code")?.textContent).toBe(
    `${window.location.origin}/mcp`,
  );
  expect(
    dialog()?.querySelector('[aria-label="Copy to clipboard"]'),
  ).not.toBeNull();
  expect(text()).toContain("Its tools start with dataforseo_. Try saying:");
  expect(text()).toContain(
    "“Use DataForSEO to find keyword ideas for a page about running shoes.”",
  );
  const links = [...(dialog()?.querySelectorAll("a[href]") ?? [])].map((link) =>
    link.getAttribute("href"),
  );
  expect(links).toEqual([CONNECT_AI_DOCS_URL, MCP_APPS_DOCS_URL]);
});

it("closes from the footer", () => {
  act(() =>
    root.render(
      <McpAppDialog name="DataForSEO" appId="dataforseo" onClose={onClose} />,
    ),
  );
  const close = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Close",
  );
  if (!close) throw new Error("no Close button");
  act(() => close.click());
  expect(onClose).toHaveBeenCalledOnce();
});

it("leaves the example out for a provider the registry doesn't know, rather than failing", () => {
  act(() =>
    root.render(<McpAppDialog name="Treg" appId="treg" onClose={onClose} />),
  );
  expect(text()).toContain("Its tools start with treg_.");
  expect(text()).not.toContain("Try saying");
  expect(text()).not.toContain("Use Treg to");
});
