// @vitest-environment happy-dom
/**
 * The monthly cap dialog rendered for real: with a workspace default it
 * offers the default, no cap or a custom cap and sends the server the
 * right shape for each; without one it is a number and Remove cap; from
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
    costMicros: 0,
    toolCalls: 0,
    monthlyCallCap: null,
    capUnlimited: false,
    effectiveMonthlyCallCap: null,
    capSource: null,
    paused: false,
    callable: true,
    ...overrides,
  };
}

function render(
  row: UsageAppRow,
  options: {
    defaultCap?: number | null;
    isCurrentMonth?: boolean;
  } = {},
) {
  act(() =>
    root.render(
      <SetMonthlyCapModal
        app={row}
        defaultCap={options.defaultCap ?? null}
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
  return document.body.querySelector<HTMLInputElement>('input[name="cap"]');
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

describe("with a workspace default", () => {
  it("offers the default, no cap and a custom cap, starting on what binds today", () => {
    render(app({ effectiveMonthlyCallCap: 1000, capSource: "default" }), {
      defaultCap: 1000,
    });
    expect(text()).toContain("Monthly cap for Notes");
    expect(radios()).toEqual([
      { label: "Workspace default (1,000 calls)", checked: true },
      { label: "No cap", checked: false },
      { label: "Custom cap", checked: false },
    ]);
    expect(capInput()).toBeNull();
    expect(text()).toContain("240 so far this month.");
    expect(text()).not.toContain("Remove cap");
  });

  it("sends unlimited for No cap", async () => {
    render(app({ effectiveMonthlyCallCap: 1000, capSource: "default" }), {
      defaultCap: 1000,
    });
    await press(radio("No cap"));
    expect(radios()[1]).toEqual({ label: "No cap", checked: true });
    await save();
    expect(sent()).toEqual([
      { appRowId: "row-notes", cap: null, unlimited: true },
    ]);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends a null cap, not unlimited, for the workspace default", async () => {
    render(app({ capUnlimited: true }), { defaultCap: 1000 });
    expect(radios()[1]).toEqual({ label: "No cap", checked: true });
    await press(radio("Workspace default"));
    await save();
    expect(sent()).toEqual([{ appRowId: "row-notes", cap: null }]);
  });

  it("sends the number for a custom cap, and refuses an empty one", async () => {
    render(app({ effectiveMonthlyCallCap: 1000, capSource: "default" }), {
      defaultCap: 1000,
    });
    await press(radio("Custom cap"));
    const input = capInput();
    expect(input).not.toBeNull();
    expect(input?.value).toBe("");
    expect(text()).toContain("240 so far this month.");
    await save();
    expect(sent()).toEqual([]);
    expect(text()).toContain("Enter a whole number of calls.");
    await type(input!, "2500");
    await save();
    expect(sent()).toEqual([{ appRowId: "row-notes", cap: 2500 }]);
  });

  it("starts on the app's own cap when it has one", () => {
    render(
      app({
        monthlyCallCap: 5000,
        effectiveMonthlyCallCap: 5000,
        capSource: "app",
      }),
      { defaultCap: 1000 },
    );
    expect(radios()[2]).toEqual({ label: "Custom cap", checked: true });
    expect(capInput()?.value).toBe("5000");
  });
});

describe("from Raise on a paused app", () => {
  it("starts on a custom cap prefilled with the default that paused it, and says where the default changes", () => {
    render(
      app({
        calls: 1000,
        effectiveMonthlyCallCap: 1000,
        capSource: "default",
        paused: true,
      }),
      { defaultCap: 1000 },
    );
    expect(text()).toContain("Raise the monthly cap for Notes");
    expect(radios()[2]).toEqual({ label: "Custom cap", checked: true });
    expect(capInput()?.value).toBe("1000");
    expect(text()).toContain(
      "The default itself is changed in the Default monthly cap row.",
    );
    expect(text()).toContain("1,000 so far this month.");
  });

  it("prefills the app's own cap without the default line", () => {
    render(
      app({
        calls: 5000,
        monthlyCallCap: 5000,
        effectiveMonthlyCallCap: 5000,
        capSource: "app",
        paused: true,
      }),
      { defaultCap: 1000 },
    );
    expect(text()).toContain("Raise the monthly cap for Notes");
    expect(capInput()?.value).toBe("5000");
    expect(text()).not.toContain("Default monthly cap row");
  });
});

describe("without a workspace default", () => {
  it("is a number with the count under it, and Remove cap once a cap exists", async () => {
    render(
      app({
        monthlyCallCap: 5000,
        effectiveMonthlyCallCap: 5000,
        capSource: "app",
      }),
    );
    expect(radios()).toEqual([]);
    expect(capInput()?.value).toBe("5000");
    expect(text()).toContain("240 so far this month.");
    await press(button("Remove cap"));
    await settle();
    expect(sent()).toEqual([{ appRowId: "row-notes", cap: null }]);
  });

  it("shows the count before any cap exists, and no Remove cap", () => {
    render(app());
    expect(capInput()?.value).toBe("");
    expect(text()).toContain("240 so far this month.");
    expect(text()).not.toContain("Remove cap");
  });

  it("drops the count for a past month", () => {
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
