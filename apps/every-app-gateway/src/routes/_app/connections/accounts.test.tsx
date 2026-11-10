// @vitest-environment happy-dom
/**
 * Connections → Accounts rendered for real with the server functions
 * mocked: one row per connection with its provider, account, app and
 * scopes, and Disconnect by connection id from the row's menu; no Connect
 * button, no organization connect, no background; no token is ever on the
 * page.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMyConnections: vi.fn(),
  disconnectConnection: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({ options }),
}));
vi.mock("@/serverFunctions/connections", () => ({
  listMyConnections: mocks.listMyConnections,
  disconnectConnection: mocks.disconnectConnection,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { Route } from "./accounts";

const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

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
  mocks.listMyConnections.mockReset();
  mocks.disconnectConnection.mockReset();
  mocks.disconnectConnection.mockResolvedValue({ ok: true, revoked: true });
  mocks.listMyConnections.mockResolvedValue({
    connections: [
      {
        id: "conn_1",
        providerId: "google-workspace",
        providerName: "Google Workspace",
        userId: "user_1",
        userEmail: "ada@acme.com",
        app: { rowId: "app_mail", id: "openmail", name: "OpenMail" },
        label: "ada@acme.com",
        scopes: ["gmail.modify", "gmail.send"],
        status: "active",
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
      },
      {
        id: "conn_2",
        providerId: "google-workspace",
        providerName: "Google Workspace",
        userId: "user_1",
        userEmail: "ada@acme.com",
        app: { rowId: "app_seo", id: "openseo", name: "OpenSEO" },
        label: "ada@acme.com",
        scopes: ["webmasters.readonly"],
        status: "expired",
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
      },
    ],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const body = () => document.body.textContent ?? "";

/** A row's cells, by the app the account is connected in. */
function rowFor(app: string): string[] {
  const row = [...container.querySelectorAll("tbody tr")].find((element) =>
    element.textContent?.includes(app),
  );
  if (!row) throw new Error(`no row for ${app}`);
  return [...row.querySelectorAll("td")].map(
    (cell) => cell.textContent?.trim() ?? "",
  );
}

/** Open a row's actions menu and press one of its items. */
async function pressRowAction(rowLabel: string, item: string) {
  const trigger = document.querySelector<HTMLElement>(
    `[aria-label="Actions for ${rowLabel}"]`,
  );
  if (!trigger) throw new Error(`no actions for ${rowLabel}`);
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    trigger.click();
  });
  await settle();
  const menuItem = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((element) => element.textContent?.trim() === item);
  if (!menuItem) throw new Error(`no ${item} item`);
  await act(async () => menuItem.click());
  await settle();
}

describe("Connected accounts", () => {
  it("lists each connection with its provider, account, app and scopes, and no way to connect here", async () => {
    await render();
    expect(rowFor("OpenMail").slice(0, 4)).toEqual([
      "Google Workspaceada@acme.com",
      "OpenMail",
      "gmail.modify, gmail.send",
      "Connected",
    ]);
    expect(rowFor("OpenSEO").slice(0, 4)).toEqual([
      "Google Workspaceada@acme.com",
      "OpenSEO",
      "webmasters.readonly",
      "Reconnect in OpenSEO",
    ]);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(body()).not.toMatch(/Connect Google|background|organization/i);
  });

  it("disconnects one connection by its id", async () => {
    await render();
    await pressRowAction("Google Workspace in OpenSEO", "Disconnect");
    expect(body()).toContain("Disconnect Google Workspace from OpenSEO?");
    const dialog = document.body.querySelector(
      '[role="alertdialog"], [role="dialog"]',
    )!;
    const confirm = [...dialog.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === "Disconnect",
    )!;
    await act(async () => confirm.click());
    await settle();
    expect(mocks.disconnectConnection).toHaveBeenCalledOnce();
    expect(mocks.disconnectConnection.mock.calls[0]![0]).toEqual({
      data: { connectionId: "conn_2" },
    });
  });

  it("says so when there is nothing connected", async () => {
    mocks.listMyConnections.mockResolvedValue({ connections: [] });
    await render();
    expect(body()).toContain("No connected accounts yet");
  });
});
