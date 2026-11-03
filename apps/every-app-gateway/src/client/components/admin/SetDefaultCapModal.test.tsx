// @vitest-environment happy-dom
/**
 * The default cap dialog rendered for real: dollars that become the
 * workspace default, Remove default once one exists, and the shared
 * description.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setDefaultMonthlyCap: vi.fn(async () => ({
    defaultMonthlyCostCapMicros: null,
  })),
}));
vi.mock("@/serverFunctions/usage", () => ({
  setDefaultMonthlyCap: mocks.setDefaultMonthlyCap,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SetDefaultCapModal } from "./SetDefaultCapModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onClose: ReturnType<typeof vi.fn>;
let onSaved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.setDefaultMonthlyCap.mockClear();
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

function render(defaultCostCapMicros: number | null) {
  act(() =>
    root.render(
      <SetDefaultCapModal
        defaultCostCapMicros={defaultCostCapMicros}
        onClose={onClose}
        onSaved={onSaved}
      />,
    ),
  );
}

const text = () => document.body.textContent ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

function capInput(name = "costUsd"): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>(
    `input[name="${name}"]`,
  );
  if (!input) throw new Error(`no ${name} input`);
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
  return mocks.setDefaultMonthlyCap.mock.calls.map(
    (call) => (call as unknown as [{ data: unknown }])[0].data,
  );
}

it("sets a default from an empty field, with no Remove default yet", async () => {
  render(null);
  expect(text()).toContain("Default monthly cap");
  expect(text()).toContain(
    "Dollars per month, for every app without its own cap",
  );
  expect(text()).toContain(
    "Counted only where the provider reports a price: OpenRouter, DataForSEO. Other calls, such as OpenAI or Workers AI, aren't capped.",
  );
  expect(capInput().value).toBe("");
  expect(text()).not.toContain("Remove default");
  await save();
  expect(sent()).toEqual([]);
  expect(text()).toContain("Enter dollars per month.");
  await type(capInput(), "0");
  await save();
  expect(sent()).toEqual([]);
  expect(text()).toContain("Enter an amount from $0.01 to $1,000,000.");
  await type(capInput(), "25.50");
  await save();
  expect(sent()).toEqual([{ costUsd: 25.5 }]);
  expect(onSaved).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it("starts on the default it has and removes it with null", async () => {
  render(20_000_000);
  expect(capInput().value).toBe("20");
  await act(async () => {
    button("Remove default").click();
  });
  await settle();
  expect(sent()).toEqual([{ costUsd: null }]);
});

it("shares the cap description, says who is emailed, and links the docs", () => {
  render(null);
  expect(text()).toContain("Dollars of provider-reported cost per UTC month");
  expect(text()).toContain(
    "Owners and admins are emailed at 80% and at the cap once the Gateway can send mail; change that under Manage workspace → Events.",
  );
  expect(
    document.body.querySelector('a[href="https://everyapp.com/docs/usage"]')
      ?.textContent,
  ).toBe("Usage and caps");
});
