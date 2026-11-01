// @vitest-environment happy-dom
/**
 * Build your own: the prompt for the person's coding agent is on screen
 * and copyable, and it sends the agent to the agent docs first.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BUILD_DOCS, BUILD_PROMPT } from "@/client/lib/buildPrompt";
import { BuildYourOwnDialog } from "./BuildYourOwnDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<BuildYourOwnDialog onClose={vi.fn()} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows the prompt, a copy button and the docs", () => {
  const text = document.body.textContent ?? "";
  expect(text).toContain(BUILD_PROMPT);
  expect(
    Array.from(document.body.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Copy prompt",
    ),
  ).toBe(true);
  expect(
    document.body.querySelector(`a[href="${BUILD_DOCS.createAnApp}"]`),
  ).not.toBeNull();
});

it("sends the agent to llms.txt, the build skill and the patterns first", () => {
  // The reading comes before the interview and before any code.
  const reading = BUILD_PROMPT.indexOf(BUILD_DOCS.llms);
  expect(reading).toBeGreaterThan(-1);
  expect(reading).toBeLessThan(BUILD_PROMPT.indexOf("interview me"));
  expect(reading).toBeLessThan(BUILD_PROMPT.indexOf("pnpm everyapp create"));
  expect(BUILD_PROMPT).toContain(BUILD_DOCS.build);
  expect(BUILD_PROMPT).toContain(BUILD_DOCS.patterns);
  expect(BUILD_PROMPT).toContain("build-every-app");
  expect(BUILD_PROMPT).toContain("pnpm everyapp create");
  expect(BUILD_PROMPT).toMatch(/never build a login page/i);
  expect(BUILD_PROMPT.split(/\s+/).length).toBeLessThanOrEqual(170);
});
