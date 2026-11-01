// @vitest-environment happy-dom
/**
 * Manage workspace → Activity rendered for real (React in a DOM) with the
 * server functions mocked: the tool calls are the default view, `?view=
 * audit` opens the audit log, whose rows show who (a member by name, an
 * AI app, the CLI's operator, an app, the Gateway), what (the type in
 * plain words and the summary) and the subject, never an event's data;
 * Load more asks for the next page by cursor; a failed load is an error,
 * not an empty log.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditActorChoice, AuditPage, AuditRow } from "@/types/audit";

const mocks = vi.hoisted(() => ({
  listToolCalls: vi.fn(),
  listToolCallApps: vi.fn(),
  listAuditEvents: vi.fn(),
  listAuditActors: vi.fn(),
  navigate: vi.fn(),
  search: { view: undefined as "audit" | "agent" | undefined },
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({ options }),
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));
vi.mock("@/serverFunctions/activity", () => ({
  listToolCalls: mocks.listToolCalls,
  listToolCallApps: mocks.listToolCallApps,
}));
vi.mock("@/serverFunctions/audit", () => ({
  listAuditEvents: mocks.listAuditEvents,
  listAuditActors: mocks.listAuditActors,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { Route } from "./activity";

const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

const T0 = Date.parse("2026-10-25T09:00:00Z");

function row(overrides: Partial<AuditRow> & { id: string }): AuditRow {
  return {
    time: T0,
    type: "member.invited",
    label: "Someone was invited to the workspace",
    summary: "Jo invited pat@acme.example as member",
    actor: { kind: "user", id: "u1", email: "jo@acme.example", name: "Jo" },
    subject: { invitation: { email: "pat@acme.example", role: "member" } },
    appEvent: false,
    ...overrides,
  };
}

const ROWS: AuditRow[] = [
  row({ id: "e1" }),
  row({
    id: "e2",
    time: T0 - 60_000,
    type: "app.updated",
    label: "An app was redeployed",
    summary: "CRM was redeployed (version 2)",
    actor: {
      kind: "operator",
      id: "ops@acme.example",
      email: "ops@acme.example",
      name: null,
    },
    subject: { app: { id: "crm", name: "CRM" } },
  }),
  row({
    id: "e3",
    time: T0 - 120_000,
    type: "app.crm.invoice.paid",
    label: "App event: invoice.paid",
    summary: "crm: invoice.paid",
    actor: { kind: "app", id: "crm", email: null, name: null },
    subject: { app: { id: "crm", name: null } },
    appEvent: true,
  }),
  row({
    id: "e4",
    time: T0 - 180_000,
    type: "app.tools_changed",
    label: "An app's tools changed",
    summary: "CRM's tools changed: 12 tools (was 10)",
    actor: { kind: "gateway", id: null, email: null, name: null },
    subject: { app: { id: "crm", name: "CRM" } },
  }),
];

const ACTORS: AuditActorChoice[] = [
  { kind: "user", id: "u1", email: "jo@acme.example", name: "Jo", events: 3 },
  { kind: "agent", id: "mcpc_1", email: null, name: "Claude", events: 1 },
  { kind: "gateway", id: null, email: null, name: null, events: 2 },
];

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
  mocks.search.view = undefined;
  mocks.listToolCalls.mockResolvedValue({ calls: [], nextBefore: null });
  mocks.listToolCallApps.mockResolvedValue([]);
  mocks.listAuditActors.mockResolvedValue(ACTORS);
  mocks.listAuditEvents.mockResolvedValue({
    events: ROWS,
    nextBefore: null,
  } satisfies AuditPage);
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

describe("the Activity page's views", () => {
  it("shows the tool calls by default and switches to the audit log through the URL", async () => {
    await render();
    expect(body()).toContain("Agent activity");
    expect(body()).toContain("No agent tool calls yet");
    expect(mocks.listToolCalls).toHaveBeenCalledTimes(1);
    expect(mocks.listAuditEvents).not.toHaveBeenCalled();

    await press(button("Audit"));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/admin/activity",
      search: { view: "audit" },
      replace: true,
    });
  });

  it("lists the audit log with who, what and the subject, never an event's data", async () => {
    mocks.search.view = "audit";
    await render();
    expect(body()).toContain("Audit log");
    expect(mocks.listAuditEvents).toHaveBeenCalledTimes(1);
    expect(mocks.listAuditEvents.mock.calls[0]![0]).toEqual({
      data: {
        actorId: undefined,
        type: undefined,
        limit: 50,
        since: undefined,
        before: undefined,
      },
    });
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(4);
    const text = rows.map((tr) => tr.textContent ?? "");
    // A member by name with their email under it.
    expect(text[0]).toContain("Jo");
    expect(text[0]).toContain("jo@acme.example");
    expect(text[0]).toContain("Someone was invited to the workspace");
    expect(text[0]).toContain("Jo invited pat@acme.example as member");
    expect(text[0]).toContain("pat@acme.example");
    // The CLI's operator, an app's own event, the Gateway itself.
    expect(text[1]).toContain("ops@acme.example");
    expect(text[1]).toContain("CLI");
    expect(text[1]).toContain("CRM");
    expect(text[2]).toContain("App event: invoice.paid");
    expect(text[2]).toContain("App event");
    expect(text[2]).toContain("crm");
    expect(text[3]).toContain("Gateway");
    expect(text[3]).toContain("An app's tools changed");
    expect(body()).toContain("Showing 4 events");
    expect(body()).not.toContain("Load more");
  });

  it("asks for the next page by the cursor the last page gave", async () => {
    mocks.search.view = "audit";
    const cursor = { time: T0 - 180_000, id: "e4" };
    mocks.listAuditEvents
      .mockResolvedValueOnce({ events: ROWS, nextBefore: cursor })
      .mockResolvedValueOnce({
        events: [row({ id: "e5", time: T0 - 240_000 })],
        nextBefore: null,
      });
    await render();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
    await press(button("Load more"));
    expect(mocks.listAuditEvents).toHaveBeenCalledTimes(2);
    expect(mocks.listAuditEvents.mock.calls[1]![0]).toMatchObject({
      data: { before: cursor },
    });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(body()).toContain("Showing 5 events");
  });

  it("says the log couldn't load rather than showing it empty, and offers a retry", async () => {
    mocks.search.view = "audit";
    mocks.listAuditEvents.mockRejectedValueOnce(new Error("boom"));
    await render();
    expect(body()).toContain("Couldn't load the audit log.");
    expect(body()).not.toContain("No audit events yet");
    await press(button("Try again"));
    expect(mocks.listAuditEvents).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
  });

  it("shows the empty state when nothing happened yet", async () => {
    mocks.search.view = "audit";
    mocks.listAuditEvents.mockResolvedValue({ events: [], nextBefore: null });
    await render();
    expect(body()).toContain("No audit events yet");
  });
});
