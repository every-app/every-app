// @vitest-environment happy-dom
/**
 * The Events tab's table rendered for real (React in a DOM): a row's
 * switch turns the subscription on and off, a dead subscription shows
 * Dead and how many attempts failed in a row (the count opens its
 * deliveries), a built-in row says so, the events read as chips or
 * "Everything", and an empty workspace learns what events are, where the
 * docs are and the CLI line.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSubscription } from "@/types/events";
import { EventSubscriptionsTable } from "./EventSubscriptionsTable";

function subscription(
  overrides: Partial<EventSubscription> = {},
): EventSubscription {
  return {
    id: "sub_0123456789abcdef01234567",
    name: "Slack #ops",
    sink: "webhook",
    url: "https://hooks.example.com/everyapp?key=never-shown",
    recipients: null,
    events: ["member.*", "cap.reached"],
    enabled: true,
    builtin: null,
    description: null,
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
    lastDeliveryAt: "2026-10-25T09:00:00.000Z",
    lastDeliveryStatus: "delivered",
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
  lastDeliveryAt: null,
  lastDeliveryStatus: null,
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
const actions = {
  onToggle: vi.fn(),
  onTest: vi.fn(),
  onDeliveries: vi.fn(),
  onEdit: vi.fn(),
  onRemove: vi.fn(),
};

function render(
  subscriptions: EventSubscription[],
  addAction?: React.ReactNode,
) {
  act(() =>
    root.render(
      <EventSubscriptionsTable
        subscriptions={subscriptions}
        isLoading={false}
        togglingId={null}
        testingId={null}
        addAction={addAction}
        {...actions}
      />,
    ),
  );
}

/** The desktop table's row for a subscription (the cards repeat it under md). */
function row(name: string): HTMLElement {
  const found = [
    ...container.querySelectorAll<HTMLElement>("table tbody tr"),
  ].find((element) => element.textContent?.includes(name));
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the subscriptions table", () => {
  it("turns a subscription off from its switch", () => {
    const slack = subscription();
    render([slack]);
    const toggle =
      row("Slack #ops").querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Send events to Slack #ops");
    act(() => toggle.click());
    expect(actions.onToggle).toHaveBeenCalledWith(slack, false);
  });

  it("shows a paused subscription's switch off", () => {
    render([subscription({ enabled: false })]);
    expect(
      row("Slack #ops")
        .querySelector('[role="switch"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("shows a dead subscription as Dead with its failures in a row, which open its deliveries", () => {
    const dead = subscription({
      lastDeliveryStatus: "dead",
      consecutiveFailures: 7,
    });
    render([dead]);
    const cells = row("Slack #ops");
    expect(cells.textContent).toContain("Dead");
    expect(cells.textContent).toContain("7 failures");
    expect(cells.textContent).toContain("in a row");
    const count = cells.querySelector<HTMLButtonElement>(
      'button[aria-label^="7 failures"]',
    )!;
    expect(count.getAttribute("aria-label")).toBe(
      "7 failures. Show the deliveries of Slack #ops",
    );
    act(() => count.click());
    expect(actions.onDeliveries).toHaveBeenCalledWith(dead);
  });

  it("shows no failure count while deliveries succeed", () => {
    render([subscription()]);
    expect(row("Slack #ops").textContent).toContain("Delivered");
    expect(row("Slack #ops").textContent).not.toContain("in a row");
  });

  it("names the target by host and path, never the URL's query", () => {
    render([subscription()]);
    expect(row("Slack #ops").textContent).toContain(
      "hooks.example.com/everyapp",
    );
    expect(container.textContent).not.toContain("never-shown");
  });

  it("marks the built-in Cap alerts row and says whom it mails", () => {
    render([CAP_ALERTS]);
    const cells = row("Cap alerts");
    expect(cells.textContent).toContain("Built-in");
    expect(cells.textContent).toContain("Email → owners and admins");
    expect(cells.textContent).toContain("Nothing sent yet");
  });

  it("shows the events as chips, and Everything for *", () => {
    render([
      subscription(),
      subscription({
        id: "sub_bbbbbbbbbbbbbbbbbbbbbbbb",
        name: "Zapier",
        events: ["*"],
      }),
    ]);
    expect(row("Slack #ops").textContent).toContain("member.*");
    expect(row("Slack #ops").textContent).toContain("cap.reached");
    expect(row("Zapier").textContent).toContain("Everything");
  });

  it("offers Send test, Deliveries, Edit, Disable and Remove in the row menu", () => {
    const slack = subscription();
    render([slack]);
    act(() =>
      row("Slack #ops")
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Actions for Slack #ops"]',
        )!
        .click(),
    );
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Send test",
      "Deliveries",
      "Edit",
      "Disable",
      "Remove",
    ]);
    act(() => {
      items
        .find((item) => item.textContent?.trim() === "Disable")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(actions.onToggle).toHaveBeenCalledWith(slack, false);
  });

  it("explains events to an empty workspace, with the docs and the CLI line", () => {
    render([], <button type="button">Add subscription</button>);
    const text = container.textContent ?? "";
    expect(text).toContain("No event subscriptions yet");
    expect(text).toContain("Slack");
    expect(text).toContain("Zapier or n8n");
    expect(text).toContain("Your own agent");
    expect(text).toContain("pnpm everyapp events add <url>");
    expect(
      container.querySelector('a[href="https://everyapp.com/docs/events"]'),
    ).not.toBeNull();
    expect(text).toContain("Add subscription");
  });
});
