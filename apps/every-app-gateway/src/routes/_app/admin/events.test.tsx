// @vitest-environment happy-dom
/**
 * Manage workspace → Events rendered for real (React in a DOM) with the
 * server functions mocked: a create that generated a signing secret shows
 * it once, in its own dialog, and after Done it is nowhere on the page;
 * Remove on the built-in Cap alerts row says it is turned off, not
 * removed, and on a person's subscription that events stop at once; the
 * switch and Send test call their server functions.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_TYPES } from "@every-app/sdk/internal";
import type { EventSubscription } from "@/types/events";

const mocks = vi.hoisted(() => ({
  listEventSubscriptions: vi.fn(),
  createEventSubscription: vi.fn(),
  updateEventSubscription: vi.fn(),
  deleteEventSubscription: vi.fn(),
  testEventSubscription: vi.fn(),
  listEventDeliveries: vi.fn(),
  redeliverEvent: vi.fn(),
  listEventTypes: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({ options }),
}));
vi.mock("@/serverFunctions/events", () => ({
  listEventSubscriptions: mocks.listEventSubscriptions,
  createEventSubscription: mocks.createEventSubscription,
  updateEventSubscription: mocks.updateEventSubscription,
  deleteEventSubscription: mocks.deleteEventSubscription,
  testEventSubscription: mocks.testEventSubscription,
  listEventDeliveries: mocks.listEventDeliveries,
  redeliverEvent: mocks.redeliverEvent,
  listEventTypes: mocks.listEventTypes,
}));
vi.mock("@/client/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({
    data: { id: "org_1", slug: "acme", name: "Acme", role: "owner" },
  }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { Route } from "./events";

const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

const SECRET = "whsec_Zm9yLXRoZS10ZXN0LW9ubHktbmV2ZXItcmVhbA";

function subscription(
  overrides: Partial<EventSubscription> = {},
): EventSubscription {
  return {
    id: "sub_0123456789abcdef01234567",
    name: "hooks.example.com",
    sink: "webhook",
    url: "https://hooks.example.com/everyapp",
    recipients: null,
    events: ["*"],
    enabled: true,
    builtin: null,
    description: null,
    createdAt: "2026-10-25T09:00:00.000Z",
    updatedAt: "2026-10-25T09:00:00.000Z",
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

const CAP_ALERTS = subscription({
  id: "sub_aaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Cap alerts",
  sink: "email",
  url: null,
  recipients: "admins",
  events: ["cap.warning", "cap.reached"],
  builtin: "cap_alerts",
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let listed: EventSubscription[];

async function settle() {
  for (let tick = 0; tick < 8; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Page />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function") mock.mockReset();
  }
  for (const mock of Object.values(mocks.toast)) mock.mockReset();
  listed = [];
  mocks.listEventSubscriptions.mockImplementation(async () => ({
    subscriptions: listed,
  }));
  mocks.listEventTypes.mockResolvedValue({ types: [...EVENT_TYPES] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const body = () => document.body.textContent ?? "";

function button(label: string, scope: Element = document.body) {
  const found = [...scope.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function typeUrl(value: string) {
  const dialog = document.body.querySelector('[role="dialog"]')!;
  const label = [...dialog.querySelectorAll("label")].find(
    (element) => element.textContent?.trim() === "URL",
  )!;
  const input = document.getElementById(
    label.getAttribute("for")!,
  ) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openRowMenu(name: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    `table button[aria-label="Actions for ${name}"]`,
  )!;
  await press(trigger);
}

async function chooseMenuItem(label: string) {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (element) => element.textContent?.trim() === label,
  )!;
  await act(async () => {
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

describe("adding a webhook", () => {
  it("shows the generated secret once, and after Done it is nowhere on the page", async () => {
    mocks.createEventSubscription.mockImplementation(async () => {
      listed = [subscription()];
      return { subscription: subscription(), secret: SECRET };
    });
    await render();
    expect(body()).toContain("No event subscriptions yet");
    await press(button("Add subscription"));
    await typeUrl("https://hooks.example.com/everyapp");
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await press(button("Add subscription", dialog));
    expect(mocks.createEventSubscription).toHaveBeenCalledWith({
      data: {
        url: "https://hooks.example.com/everyapp",
        name: undefined,
        events: ["*"],
        secret: undefined,
      },
    });
    expect(body()).toContain("Signing secret for hooks.example.com");
    expect(body()).toContain("Copy it now; it isn't shown again.");
    expect(body()).toContain(SECRET);
    // The table behind it lists the new row, without the secret.
    expect(container.querySelector("table")?.textContent).toContain(
      "hooks.example.com/everyapp",
    );
    expect(container.textContent).not.toContain(SECRET);
    await press(button("Done"));
    expect(body()).not.toContain(SECRET);
    expect(body()).toContain("hooks.example.com/everyapp");
  });

  it("shows no secret when the person gave their own", async () => {
    mocks.createEventSubscription.mockImplementation(async () => {
      listed = [subscription()];
      return { subscription: subscription() };
    });
    await render();
    await press(button("Add subscription"));
    await typeUrl("https://hooks.example.com/everyapp");
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await press(button("Add subscription", dialog));
    expect(body()).not.toContain("Signing secret for");
    expect(mocks.toast.success).toHaveBeenCalledWith("hooks.example.com added");
  });
});

describe("removing a subscription", () => {
  it("says a built-in row is turned off, not removed", async () => {
    listed = [CAP_ALERTS];
    mocks.deleteEventSubscription.mockResolvedValue({
      removed: false,
      disabled: true,
    });
    await render();
    await openRowMenu("Cap alerts");
    await chooseMenuItem("Remove");
    expect(body()).toContain("turned off, not removed");
    await press(button("Turn off"));
    expect(mocks.deleteEventSubscription).toHaveBeenCalledWith({
      data: { id: CAP_ALERTS.id },
    });
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Cap alerts is turned off",
    );
  });

  it("says events stop going to a person's subscription at once", async () => {
    listed = [subscription({ name: "Slack #ops" })];
    mocks.deleteEventSubscription.mockResolvedValue({
      removed: true,
      disabled: false,
    });
    await render();
    await openRowMenu("Slack #ops");
    await chooseMenuItem("Remove");
    expect(body()).toContain("Events stop going to it at once.");
    await press(button("Remove subscription"));
    expect(mocks.toast.success).toHaveBeenCalledWith("Subscription removed");
  });
});

describe("a row's switch and Send test", () => {
  it("turns a subscription off", async () => {
    listed = [subscription({ name: "Slack #ops" })];
    mocks.updateEventSubscription.mockImplementation(async () => {
      listed = [subscription({ name: "Slack #ops", enabled: false })];
      return { subscription: listed[0] };
    });
    await render();
    await press(
      container.querySelector<HTMLElement>(
        'table [role="switch"][aria-label="Send events to Slack #ops"]',
      )!,
    );
    expect(mocks.updateEventSubscription).toHaveBeenCalledWith({
      data: { id: "sub_0123456789abcdef01234567", enabled: false },
    });
    expect(
      container
        .querySelector('table [role="switch"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("reports a failed test with the error in words", async () => {
    listed = [subscription({ name: "Slack #ops" })];
    mocks.testEventSubscription.mockResolvedValue({
      delivery: {
        id: "dlv_aaaaaaaaaaaaaaaaaaaaaaaa",
        subscriptionId: "sub_0123456789abcdef01234567",
        status: "pending",
        attempts: 1,
        nextAttemptAt: "2026-10-25T09:01:00.000Z",
        lastAttemptAt: "2026-10-25T09:00:00.000Z",
        lastStatusCode: 404,
        lastError: "status_404: no such hook",
        deliveredAt: null,
        redeliveredAt: null,
        createdAt: "2026-10-25T09:00:00.000Z",
        event: null,
      },
    });
    await render();
    await openRowMenu("Slack #ops");
    await chooseMenuItem("Send test");
    expect(mocks.testEventSubscription).toHaveBeenCalledWith({
      data: { id: "sub_0123456789abcdef01234567" },
    });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Test to Slack #ops failed",
      { description: "HTTP 404: no such hook" },
    );
  });
});
