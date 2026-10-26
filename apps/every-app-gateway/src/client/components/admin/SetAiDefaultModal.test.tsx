// @vitest-environment happy-dom
/**
 * The AI default dialog rendered for real: the candidates with their key
 * state and model, the current choice preselected, an optional model,
 * and "Use the shipped order" once a choice is stored.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiDefaultReport } from "./SetAiDefaultModal";

const mocks = vi.hoisted(() => ({
  setAiDefault: vi.fn(async (_input: unknown) => ({}) as unknown),
}));
vi.mock("@/serverFunctions/ai", () => ({
  setAiDefault: mocks.setAiDefault,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SetAiDefaultModal } from "./SetAiDefaultModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const route = { path: "/v1/chat/completions", seedModel: "x" };
const candidates = [
  {
    id: "openrouter",
    label: "OpenRouter",
    settings: ["OPENROUTER_API_KEY"],
    configured: true,
    model: "anthropic/claude-haiku-5.5",
    viaAiGateway: false,
    embeddings: true,
  },
  {
    id: "groq",
    label: "Groq",
    settings: ["GROQ_API_KEY"],
    configured: false,
    model: "openai/gpt-oss-20b",
    viaAiGateway: false,
    embeddings: false,
  },
];

function report(choice: string | null): AiDefaultReport {
  const groq = choice?.startsWith("groq") ?? false;
  return {
    resolution: {
      provider: groq ? "groq" : "openrouter",
      label: groq ? "Groq" : "OpenRouter",
      model: groq
        ? (choice!.split("/").slice(1).join("/") ?? "openai/gpt-oss-20b")
        : "anthropic/claude-haiku-5.5",
      source: choice ? "setting" : "order",
      configured: !groq,
      settings: [groq ? "GROQ_API_KEY" : "OPENROUTER_API_KEY"],
      via: "direct",
      chat: route,
      candidates,
    },
    choice,
    models: {},
    aiGateway: { on: false },
  } as AiDefaultReport;
}

let root: Root;
let container: HTMLElement;
let onClose: ReturnType<typeof vi.fn>;
let onSaved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.setAiDefault.mockReset();
  mocks.setAiDefault.mockImplementation(async () => report(null));
  onClose = vi.fn();
  onSaved = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(choice: string | null) {
  act(() =>
    root.render(
      <SetAiDefaultModal
        report={report(choice)}
        onClose={onClose}
        onSaved={onSaved}
      />,
    ),
  );
}

const text = () => document.body.textContent ?? "";

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
}

function modelInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>(
    'input[name="model"]',
  );
  if (!input) throw new Error("no model input");
  return input;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  for (let tick = 0; tick < 10; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function save() {
  const form = document.body.querySelector("form");
  if (!form) throw new Error("no form");
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

function sent() {
  return mocks.setAiDefault.mock.calls.map(
    (call) => (call as unknown as [{ data: unknown }])[0].data,
  );
}

it("preselects what serves now and saves it with the provider's own model", async () => {
  render(null);
  expect(text()).toContain("AI default");
  expect(text()).toContain("OpenRouter · key set · anthropic/claude-haiku-5.5");
  expect(modelInput().value).toBe("");
  expect(modelInput().placeholder).toBe("anthropic/claude-haiku-5.5");
  expect(text()).toContain(
    "Leave empty to keep the provider's model (shown). A model id may contain slashes.",
  );
  // Nothing stored: the order already decides.
  expect(button("Use the shipped order")).toBeUndefined();
  await save();
  expect(sent()).toEqual([{ provider: "openrouter" }]);
  expect(onSaved).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it("lists every candidate with its key state, and a pick changes the placeholder", async () => {
  render(null);
  const trigger = document.body.querySelector<HTMLElement>(
    '[data-slot="select-trigger"]',
  );
  if (!trigger) throw new Error("no select trigger");
  await press(trigger);
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (element) =>
      element.textContent?.trim() === "Groq · key not set · openai/gpt-oss-20b",
  ) as HTMLElement | undefined;
  if (!option) throw new Error("no Groq option");
  await press(option);
  expect(modelInput().placeholder).toBe("openai/gpt-oss-20b");
  await type(modelInput(), "  openai/gpt-oss-120b ");
  await save();
  expect(sent()).toEqual([{ provider: "groq", model: "openai/gpt-oss-120b" }]);
});

it("starts on the stored choice, refuses a model over 200 characters, and clears with a null provider", async () => {
  render("groq/openai/gpt-oss-120b");
  expect(modelInput().value).toBe("openai/gpt-oss-120b");
  await type(modelInput(), "m".repeat(201));
  await save();
  expect(sent()).toEqual([]);
  expect(text()).toContain("A model id is at most 200 characters.");
  await press(button("Use the shipped order")!);
  expect(sent()).toEqual([{ provider: null }]);
  expect(onSaved).toHaveBeenCalledOnce();
});
