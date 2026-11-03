// @vitest-environment happy-dom
/**
 * The monthly cap dialog rendered for real: with a workspace default it
 * offers the default, no cap or a custom cap and sends the server the
 * right shape for each; without one it is dollars and Remove cap; from
 * Raise it starts on a custom cap prefilled with what binds today.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageAppRow } from "@/types/usage";

const mocks = vi.hoisted(() => ({
  setAppMonthlyCap: vi.fn(async () => ({})),
}));
vi.mock("@/serverFunctions/usage", () => ({
  setAppMonthlyCap: mocks.setAppMonthlyCap,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SetMonthlyCapModal } from "./SetMonthlyCapModal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onClose: ReturnType<typeof vi.fn>;
let onSaved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.setAppMonthlyCap.mockClear();
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

function app(overrides: Partial<UsageAppRow> = {}): UsageAppRow {
  return {
    appRowId: "row-notes",
    name: "Notes",
    appSlug: "notes",
    calls: 240,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 4_200_000,
    toolCalls: 0,
    capUnlimited: false,
    monthlyCostCapMicros: null,
    effectiveMonthlyCostCapMicros: null,
    costCapSource: null,
    paused: false,
    callable: true,
    ...overrides,
  };
}

function render(
  row: UsageAppRow,
  options: {
    defaultCostCapMicros?: number | null;
    isCurrentMonth?: boolean;
  } = {},
) {
  act(() =>
    root.render(
      <SetMonthlyCapModal
        app={row}
        defaultCostCapMicros={options.defaultCostCapMicros ?? null}
        isCurrentMonth={options.isCurrentMonth ?? true}
        onClose={onClose}
        onSaved={onSaved}
      />,
    ),
  );
}

// The dialog renders in a portal: read the whole document.
const text = () => document.body.textContent ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** The three-way choice: each radio with the label beside it. */
function radioItems(): { item: HTMLElement; label: string }[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="radio"]')].map(
    (item) => ({
      item,
      label:
        item.closest('[data-slot="field"]')?.querySelector("label")
          ?.textContent ?? "",
    }),
  );
}

function radios(): { label: string; checked: boolean }[] {
  return radioItems().map(({ item, label }) => ({
    label,
    checked: item.getAttribute("aria-checked") === "true",
  }));
}

function radio(label: string): HTMLElement {
  const found = radioItems().find((entry) => entry.label.startsWith(label));
  if (!found) throw new Error(`no ${label} option`);
  return found.item;
}

function capInput(): HTMLInputElement | null {
  return document.body.querySelector<HTMLInputElement>('input[name="costUsd"]');
}

async function type(input: HTMLInputElement, value: string) {
  // React reads the value through its own tracker: set it as the DOM does.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(element: HTMLElement) {
  await act(async () => {
    element.click();
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
  return mocks.setAppMonthlyCap.mock.calls.map(
    (call) => (call as unknown as [{ data: unknown }])[0].data,
  );
}

const underDefault = () =>
  app({ effectiveMonthlyCostCapMicros: 20_000_000, costCapSource: "default" });
const DEFAULT = { defaultCostCapMicros: 20_000_000 };

describe("with a workspace default", () => {
  it("offers the default, no cap and a custom cap, starting on what binds today", () => {
    render(underDefault(), DEFAULT);
    expect(text()).toContain("Monthly cap for Notes");
    expect(radios()).toEqual([
      { label: "Workspace default ($20.00)", checked: true },
      { label: "No cap", checked: false },
      { label: "Custom cap", checked: false },
    ]);
    expect(capInput()).toBeNull();
    expect(text()).toContain("$4.20 so far this month.");
    expect(text()).not.toContain("Remove cap");
  });

  it("sends unlimited for No cap", async () => {
    render(underDefault(), DEFAULT);
    await press(radio("No cap"));
    expect(radios()[1]).toEqual({ label: "No cap", checked: true });
    await save();
    expect(sent()).toEqual([
      { appRowId: "row-notes", costUsd: null, unlimited: true },
    ]);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends null, not unlimited, for the workspace default", async () => {
    render(app({ capUnlimited: true }), DEFAULT);
    expect(radios()[1]).toEqual({ label: "No cap", checked: true });
    await press(radio("Workspace default"));
    await save();
    expect(sent()).toEqual([{ appRowId: "row-notes", costUsd: null }]);
  });

  it("sends dollars for a custom cap, says which calls count, and refuses an empty one or a fraction of a cent", async () => {
    render(underDefault(), DEFAULT);
    await press(radio("Custom cap"));
    const input = capInput();
    expect(input).not.toBeNull();
    expect(input?.value).toBe("");
    expect(text()).toContain("Dollars per month");
    expect(text()).toContain(
      "Counted only where the provider reports a price: OpenRouter, DataForSEO. Other calls, such as OpenAI or Workers AI, aren't capped. $4.20 so far this month.",
    );
    await save();
    expect(sent()).toEqual([]);
    expect(text()).toContain("Enter dollars per month.");
    await type(input!, "12.345");
    await save();
    expect(sent()).toEqual([]);
    expect(text()).toContain("Enter dollars, with at most two decimals.");
    await type(input!, "12.5");
    await save();
    expect(sent()).toEqual([{ appRowId: "row-notes", costUsd: 12.5 }]);
  });

  it("starts on the app's own cap when it has one", () => {
    render(
      app({
        monthlyCostCapMicros: 7_250_000,
        effectiveMonthlyCostCapMicros: 7_250_000,
        costCapSource: "app",
      }),
      DEFAULT,
    );
    expect(radios()[2]).toEqual({ label: "Custom cap", checked: true });
    expect(capInput()?.value).toBe("7.25");
  });
});

describe("from Raise on a paused app", () => {
  it("starts on a custom cap prefilled with the default that paused it, and says where the default changes", () => {
    render(
      app({
        costMicros: 20_000_000,
        effectiveMonthlyCostCapMicros: 20_000_000,
        costCapSource: "default",
        paused: true,
      }),
      DEFAULT,
    );
    expect(text()).toContain("Raise the monthly cap for Notes");
    expect(radios()[2]).toEqual({ label: "Custom cap", checked: true });
    expect(capInput()?.value).toBe("20");
    expect(text()).toContain(
      "The default itself is changed in the Default monthly cap row.",
    );
    expect(text()).toContain("$20.00 so far this month.");
  });

  it("prefills the app's own cap without the default line", () => {
    render(
      app({
        costMicros: 50_000_000,
        monthlyCostCapMicros: 50_000_000,
        effectiveMonthlyCostCapMicros: 50_000_000,
        costCapSource: "app",
        paused: true,
      }),
      DEFAULT,
    );
    expect(text()).toContain("Raise the monthly cap for Notes");
    expect(capInput()?.value).toBe("50");
    expect(text()).not.toContain("Default monthly cap row");
  });
});

describe("without a workspace default", () => {
  it("is dollars with the month's cost under it, and Remove cap once a cap exists", async () => {
    render(
      app({
        monthlyCostCapMicros: 50_000_000,
        effectiveMonthlyCostCapMicros: 50_000_000,
        costCapSource: "app",
      }),
    );
    expect(radios()).toEqual([]);
    expect(capInput()?.value).toBe("50");
    expect(text()).toContain("$4.20 so far this month.");
    await press(button("Remove cap"));
    await settle();
    expect(sent()).toEqual([{ appRowId: "row-notes", costUsd: null }]);
  });

  it("shows the cost before any cap exists, and no Remove cap", () => {
    render(app());
    expect(capInput()?.value).toBe("");
    expect(text()).toContain("$4.20 so far this month.");
    expect(text()).not.toContain("Remove cap");
  });

  it("drops the cost for a past month", () => {
    render(app(), { isCurrentMonth: false });
    expect(text()).not.toContain("so far this month");
  });
});

describe("the description", () => {
  it("says what a cap does, who is emailed, and links the docs", () => {
    render(app());
    expect(text()).toContain(
      "Once reached, the Gateway refuses the app's calls",
    );
    expect(text()).toContain(
      "Owners and admins are emailed at 80% and at the cap once the Gateway can send mail; change that under Manage workspace → Events.",
    );
    expect(
      document.body.querySelector('a[href="https://everyapp.com/docs/usage"]')
        ?.textContent,
    ).toBe("Usage and caps");
  });
});
