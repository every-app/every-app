// @vitest-environment happy-dom
/**
 * The AI default card on Usage: provider and model, the source sentence,
 * Not configured with the settings, AI Gateway, the problem, Change.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiDefaultCard } from "./AiDefaultCard";
import type { AiDefaultReport } from "./SetAiDefaultModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Resolution = AiDefaultReport["resolution"];

function report(overrides: Partial<Resolution>): AiDefaultReport {
  return {
    resolution: {
      provider: "openrouter",
      label: "OpenRouter",
      model: "anthropic/claude-haiku-5.5",
      source: "order",
      configured: true,
      settings: ["OPENROUTER_API_KEY"],
      via: "direct",
      chat: { path: "/api/v1/chat/completions", seedModel: "x" },
      candidates: [],
      ...overrides,
    } as Resolution,
    choice: null,
    aiGateway: { on: false },
  };
}

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

function render(value: AiDefaultReport | undefined, onChange = vi.fn()) {
  act(() => root.render(<AiDefaultCard report={value} onChange={onChange} />));
  return onChange;
}

const text = () => container.textContent ?? "";

it("shows the order's pick, configured and direct", () => {
  const onChange = render(report({}));
  expect(text()).toContain("OpenRouter · anthropic/claude-haiku-5.5");
  expect(text()).toContain("Automatic");
  expect(text()).not.toContain("Not configured");
  expect(text()).not.toContain("Through Cloudflare AI Gateway");
  act(() => container.querySelector("button")!.click());
  expect(onChange).toHaveBeenCalledOnce();
});

it("shows a stored choice with its missing key, AI Gateway and a problem", () => {
  render(
    report({
      provider: "groq",
      label: "Groq",
      model: "openai/gpt-oss-20b",
      source: "setting",
      configured: false,
      settings: ["GROQ_API_KEY"],
      via: "ai-gateway",
      problem: "Something to fix.",
    }),
  );
  expect(text()).not.toContain("Automatic");
  expect(text()).toContain("Not configured · GROQ_API_KEY");
  expect(text()).toContain("Through Cloudflare AI Gateway");
  expect(text()).toContain("Something to fix.");
});

it("says when no key is set, and waits while loading", () => {
  render(report({ source: "none", configured: false }));
  expect(text()).toContain("No AI key set yet.");
  render(undefined);
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  expect(container.querySelector("button")!.disabled).toBe(true);
});
