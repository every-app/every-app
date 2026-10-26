// @vitest-environment happy-dom
/**
 * The Add subscription dialog rendered for real (React in a DOM): it
 * refuses what the server would (no URL, a secret too short, no events
 * chosen) under the field at fault, sends a blank secret as none so the
 * Gateway generates one, sends the checked groups, types and typed
 * patterns, shows the server's own refusal of a URL under the URL until
 * the URL changes, adds an email subscription, and edits a subscription's
 * name and events with its URL fixed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_TYPES } from "@every-app/sdk/internal";
import type { EventSubscription } from "@/types/events";

const mocks = vi.hoisted(() => ({ listEventTypes: vi.fn() }));
vi.mock("@/serverFunctions/events", () => ({
  listEventTypes: mocks.listEventTypes,
}));

import { AddEventSubscriptionDialog } from "./AddEventSubscriptionDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onSubmit: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

async function settle() {
  for (let tick = 0; tick < 5; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

async function render(subscription?: EventSubscription) {
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AddEventSubscriptionDialog
          subscription={subscription}
          onSubmit={onSubmit}
          onClose={onClose}
        />
      </QueryClientProvider>,
    ),
  );
  for (let tick = 0; tick < 10; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    if (dialog()?.textContent?.includes("All events")) return;
  }
  throw new Error("the dialog never loaded the event types");
}

beforeEach(() => {
  mocks.listEventTypes.mockReset();
  mocks.listEventTypes.mockResolvedValue({ types: [...EVENT_TYPES] });
  onSubmit = vi.fn(async () => undefined);
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

function button(label: string): HTMLButtonElement {
  const found = [...dialog()!.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** The control a label names. */
function field(label: string): HTMLInputElement | null {
  const found = [...dialog()!.querySelectorAll("label")].find(
    (element) => element.textContent?.trim() === label,
  );
  const id = found?.getAttribute("for");
  return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
}

async function type(label: string, value: string) {
  const input = field(label);
  if (!input) throw new Error(`no ${label} field`);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * The checkbox of the label whose text starts with `start`: inside it (a
 * type or a group) or beside it in its field.
 */
function checkbox(start: string): HTMLElement {
  const label = [...dialog()!.querySelectorAll("label")].find((element) =>
    element.textContent?.trim().startsWith(start),
  );
  const box =
    label?.querySelector<HTMLElement>('[role="checkbox"]') ??
    label
      ?.closest('[data-slot="field"]')
      ?.querySelector<HTMLElement>('[role="checkbox"]');
  if (!box) throw new Error(`no ${start} checkbox`);
  return box;
}

/**
 * Toggle a checkbox: a type's or a group's by its input (a click on the
 * box inside a label bubbles to the label and toggles twice), any other
 * by its box.
 */
async function toggle(start: string) {
  const box = checkbox(start);
  const input = box
    .closest("label")
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  await press(input ?? box);
}

/** Leave All events for the type checkboxes. */
async function chooseEvents() {
  await press(
    dialog()!.querySelector<HTMLElement>(
      '[role="radio"][aria-label="Choose events"]',
    )!,
  );
}

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function submit(label = "Add subscription") {
  await press(button(label));
}

describe("adding a webhook", () => {
  it("refuses one without a URL and says so under the URL", async () => {
    await render();
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field("URL")?.getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("Enter the URL the events go to.");
  });

  it("refuses a secret too short and no events at all, each under its field", async () => {
    await render();
    await type("URL", "https://hooks.example.com/everyapp");
    await type("Signing secret (optional)", "short");
    await chooseEvents();
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(text()).toContain(
      "A signing secret is 16 to 128 characters with no spaces, or blank.",
    );
    expect(text()).toContain("Choose at least one event, or All events.");
  });

  it("sends everything with a blank secret, so the Gateway generates one", async () => {
    await render();
    expect(text()).toContain("Leave blank to generate one.");
    await type("URL", "https://hooks.example.com/everyapp");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      url: "https://hooks.example.com/everyapp",
      name: undefined,
      events: ["*"],
      secret: undefined,
    });
  });

  it("sends the checked group, a single type and an app's own pattern", async () => {
    await render();
    await type("URL", "https://hooks.example.com/everyapp");
    await type("Name", "Slack #ops");
    await chooseEvents();
    await toggle("Members");
    // A checked group takes its types: they read as checked and fixed.
    expect(checkbox("member.joined").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("member.joined").getAttribute("aria-disabled")).toBe(
      "true",
    );
    await toggle("cap.reached");
    await type("Patterns", "app.crm.*");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      url: "https://hooks.example.com/everyapp",
      name: "Slack #ops",
      events: ["member.*", "cap.reached", "app.crm.*"],
      secret: undefined,
    });
  });

  it("refuses a typed pattern that matches nothing, by the server's own rule", async () => {
    await render();
    await type("URL", "https://hooks.example.com/everyapp");
    await chooseEvents();
    await type("Patterns", "billing.*");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field("Patterns")?.getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain('"billing.*" matches no event type');
  });

  it("shows the server's refusal of the URL under it, until the URL changes", async () => {
    onSubmit.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "That host is local or private. An operator can allow private targets on a self-hosted gateway with EVENTS_ALLOW_PRIVATE_TARGETS=true.",
        ),
        { code: "EVENT_TARGET_REFUSED" },
      ),
    );
    await render();
    await type("URL", "https://n8n.corp/hook");
    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(field("URL")?.getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("That host is local or private.");
    await type("URL", "https://n8n.example.com/hook");
    await settle();
    expect(text()).not.toContain("That host is local or private.");
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("shows a refusal that belongs to no field above the buttons", async () => {
    onSubmit.mockRejectedValueOnce(
      Object.assign(new Error("limit"), { code: "EVENT_SUBSCRIPTIONS_LIMIT" }),
    );
    await render();
    await type("URL", "https://hooks.example.com/everyapp");
    await submit();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain(
      "as many event subscriptions as it may",
    );
  });
});

describe("adding an email subscription", () => {
  it("sends the recipients and no URL or secret", async () => {
    await render();
    await press(
      dialog()!.querySelector<HTMLElement>(
        '[role="radio"][aria-label="Email"]',
      )!,
    );
    expect(field("URL")).toBeNull();
    expect(field("Signing secret (optional)")).toBeNull();
    expect(text()).toContain("Owners and admins");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      email: "admins",
      name: undefined,
      events: ["*"],
    });
  });
});

describe("editing a subscription", () => {
  const slack: EventSubscription = {
    id: "sub_0123456789abcdef01234567",
    name: "Slack #ops",
    sink: "webhook",
    url: "https://hooks.example.com/everyapp?token=hook-own-token",
    recipients: null,
    events: ["member.*", "app.crm.*"],
    enabled: true,
    builtin: null,
    description: null,
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
    consecutiveFailures: 0,
  };

  it("keeps the URL fixed, shown as host and path without its query, and sends the name and events", async () => {
    await render(slack);
    expect(text()).toContain("Edit Slack #ops");
    expect(field("URL")).toBeNull();
    expect(text()).toContain("hooks.example.com/everyapp");
    expect(text()).not.toContain("hook-own-token");
    expect(field("Signing secret (optional)")).toBeNull();
    expect(checkbox("Members").getAttribute("aria-checked")).toBe("true");
    expect(field("Patterns")?.value).toBe("app.crm.*");
    await type("Name", "Slack #alerts");
    await submit("Save");
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Slack #alerts",
      events: ["member.*", "app.crm.*"],
    });
  });
});
