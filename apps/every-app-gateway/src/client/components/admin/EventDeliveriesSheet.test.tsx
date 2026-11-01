// @vitest-environment happy-dom
/**
 * The deliveries sheet rendered for real (React in a DOM): each delivery
 * says its event, attempts, state and last error in words; Redeliver is
 * offered on failed and dead deliveries only and sends the delivery's id;
 * "Show payload" opens the envelope the receiver got; the Dead filter asks
 * the server for the dead letters; Load more continues from the cursor.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDelivery, EventSubscription } from "@/types/events";

const mocks = vi.hoisted(() => ({
  listEventDeliveries: vi.fn(),
  redeliverEvent: vi.fn(),
}));
vi.mock("@/serverFunctions/events", () => ({
  listEventDeliveries: mocks.listEventDeliveries,
  redeliverEvent: mocks.redeliverEvent,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { EventDeliveriesSheet } from "./EventDeliveriesSheet";

const SLACK: EventSubscription = {
  id: "sub_0123456789abcdef01234567",
  name: "Slack #ops",
  sink: "webhook",
  url: "https://hooks.example.com/everyapp",
  recipients: null,
  events: ["*"],
  enabled: true,
  builtin: null,
  description: null,
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
  lastDeliveryAt: "2026-10-25T09:00:00.000Z",
  lastDeliveryStatus: "dead",
  consecutiveFailures: 7,
};

function delivery(
  id: string,
  overrides: Partial<EventDelivery> = {},
): EventDelivery {
  return {
    id,
    subscriptionId: SLACK.id,
    status: "delivered",
    attempts: 1,
    nextAttemptAt: null,
    lastAttemptAt: "2026-10-25T09:00:01.000Z",
    lastStatusCode: 200,
    lastError: null,
    deliveredAt: "2026-10-25T09:00:01.000Z",
    redeliveredAt: null,
    createdAt: "2026-10-25T09:00:00.000Z",
    event: {
      id: `evt_${id.slice(4).toUpperCase().padEnd(26, "0")}`,
      type: "member.joined",
      version: 1,
      summary: "jo@acme.com joined as member",
      time: "2026-10-25T09:00:00.000Z",
      actor: { kind: "user", id: "usr_1", email: "ada@acme.com" },
      data: { user: { id: "usr_2", email: "jo@acme.com" }, role: "member" },
      appRowId: null,
    },
    ...overrides,
  };
}

const DELIVERED = delivery("dlv_aaaaaaaaaaaaaaaaaaaaaaaa");
const FAILED = delivery("dlv_bbbbbbbbbbbbbbbbbbbbbbbb", {
  status: "pending",
  attempts: 2,
  nextAttemptAt: "2026-10-25T09:35:00.000Z",
  lastStatusCode: 500,
  lastError: "status_500: upstream down",
  deliveredAt: null,
});
const DEAD = delivery("dlv_cccccccccccccccccccccccc", {
  status: "dead",
  attempts: 7,
  lastStatusCode: null,
  lastError: "timeout",
  deliveredAt: null,
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

async function settle() {
  for (let tick = 0; tick < 8; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

async function render(
  subscription: EventSubscription | null = SLACK,
  subscriptions: EventSubscription[] = [SLACK],
) {
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <EventDeliveriesSheet
          subscription={subscription}
          subscriptions={subscriptions}
          envelope={{
            gateway: "https://apps.acme.com",
            organization: { id: "org_1", slug: "acme", name: "Acme" },
          }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

beforeEach(() => {
  mocks.listEventDeliveries.mockReset();
  mocks.listEventDeliveries.mockResolvedValue({
    deliveries: [DELIVERED, FAILED, DEAD],
    nextCursor: null,
  });
  mocks.redeliverEvent.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const sheet = () =>
  document.body.querySelector<HTMLElement>('[role="dialog"]')!;

function row(id: string): HTMLElement {
  const found = sheet().querySelector<HTMLElement>(`[data-delivery="${id}"]`);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

function buttonIn(element: Element, label: string) {
  return [...element.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

describe("the deliveries sheet", () => {
  it("lists one subscription's deliveries with their state and last error in words", async () => {
    await render();
    expect(mocks.listEventDeliveries).toHaveBeenCalledWith({
      data: {
        subscriptionId: SLACK.id,
        status: undefined,
        before: undefined,
        limit: 25,
      },
    });
    expect(sheet().textContent).toContain("Deliveries to Slack #ops");
    expect(row(DELIVERED.id).textContent).toContain("Delivered");
    expect(row(DELIVERED.id).textContent).toContain("HTTP 200");
    expect(row(FAILED.id).textContent).toContain("Failed");
    expect(row(FAILED.id).textContent).toContain("2 attempts");
    expect(row(FAILED.id).textContent).toContain("HTTP 500");
    expect(row(FAILED.id).textContent).toContain("upstream down");
    expect(row(FAILED.id).textContent).toContain("next attempt");
    expect(row(DEAD.id).textContent).toContain("Dead");
    expect(row(DEAD.id).textContent).toContain("No answer within 10 seconds");
  });

  it("offers Redeliver on failed and dead deliveries only, and sends the delivery's id", async () => {
    mocks.redeliverEvent.mockResolvedValue({
      delivery: { ...DEAD, status: "delivered", lastError: null },
    });
    await render();
    expect(buttonIn(row(DELIVERED.id), "Redeliver")).toBeUndefined();
    expect(buttonIn(row(FAILED.id), "Redeliver")).toBeDefined();
    await press(buttonIn(row(DEAD.id), "Redeliver")!);
    expect(mocks.redeliverEvent).toHaveBeenCalledWith({
      data: { deliveryId: DEAD.id },
    });
    // The list is read again, so the row shows how the new attempt went.
    expect(mocks.listEventDeliveries.mock.calls.length).toBeGreaterThan(1);
  });

  it("shows the envelope the receiver got under Show payload", async () => {
    await render();
    const show = buttonIn(row(DELIVERED.id), "Show payload")!;
    expect(show.getAttribute("aria-expanded")).toBe("false");
    await press(show);
    const code = row(DELIVERED.id).querySelector("pre code")?.textContent ?? "";
    const envelope = JSON.parse(code) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      id: DELIVERED.event!.id,
      type: "member.joined",
      version: 1,
      summary: "jo@acme.com joined as member",
      gateway: "https://apps.acme.com",
      organization: { id: "org_1", slug: "acme", name: "Acme" },
      data: { role: "member" },
    });
    expect(buttonIn(row(DELIVERED.id), "Hide payload")).toBeDefined();
  });

  it("asks the server for the dead letters under the Dead filter, across subscriptions", async () => {
    await render(null);
    expect(row(DEAD.id).textContent).toContain("Slack #ops");
    const dead = [...sheet().querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Dead",
    )!;
    await press(dead);
    expect(mocks.listEventDeliveries).toHaveBeenLastCalledWith({
      data: {
        subscriptionId: undefined,
        status: "dead",
        before: undefined,
        limit: 25,
      },
    });
  });

  it("loads the next page from the cursor", async () => {
    mocks.listEventDeliveries.mockResolvedValueOnce({
      deliveries: [DELIVERED],
      nextCursor: "1761382800000:dlv_aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    mocks.listEventDeliveries.mockResolvedValueOnce({
      deliveries: [DEAD],
      nextCursor: null,
    });
    await render();
    await press(buttonIn(sheet(), "Load more")!);
    expect(mocks.listEventDeliveries).toHaveBeenLastCalledWith({
      data: {
        subscriptionId: SLACK.id,
        status: undefined,
        before: "1761382800000:dlv_aaaaaaaaaaaaaaaaaaaaaaaa",
        limit: 25,
      },
    });
    expect(row(DEAD.id)).toBeTruthy();
    expect(buttonIn(sheet(), "Load more")).toBeUndefined();
  });

  it("says how many people a delivered email reached, not a bare number", async () => {
    const capAlerts: EventSubscription = {
      ...SLACK,
      id: "sub_fedcba9876543210fedcba98",
      name: "Cap alerts",
      sink: "email",
      url: null,
      recipients: "admins",
    };
    const mailed = delivery("dlv_dddddddddddddddddddddddd", {
      subscriptionId: capAlerts.id,
      lastStatusCode: 2,
    });
    mocks.listEventDeliveries.mockResolvedValue({
      deliveries: [mailed, DELIVERED],
      nextCursor: null,
    });
    await render(null, [SLACK, capAlerts]);
    expect(row(mailed.id).textContent).toContain("Cap alerts");
    expect(row(mailed.id).textContent).toContain("mailed to 2");
    expect(row(mailed.id).textContent).not.toContain("HTTP");
    expect(row(DELIVERED.id).textContent).toContain("HTTP 200");
  });

  it("says when there are no dead letters", async () => {
    mocks.listEventDeliveries.mockResolvedValue({
      deliveries: [],
      nextCursor: null,
    });
    await render(null);
    const dead = [...sheet().querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Dead",
    )!;
    await press(dead);
    expect(sheet().textContent).toContain("No dead deliveries");
  });
});
