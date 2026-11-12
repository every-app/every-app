// @vitest-environment happy-dom
/**
 * Your connections → Accounts rendered for real with the server functions
 * mocked: one row per connection with its provider, account, scopes and
 * the apps allowed to use it; one app's access taken away by the
 * connection's id and the app's row id; Disconnect by connection id from
 * the row's menu, saying every app stops; no Connect button, no
 * organization connect, no background; no token is ever on the page.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMyConnections: vi.fn(),
  disconnectConnection: vi.fn(),
  removeConnectionApp: vi.fn(),
  reconnectConnection: vi.fn(),
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
  removeConnectionApp: mocks.removeConnectionApp,
  reconnectConnection: mocks.reconnectConnection,
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
  mocks.removeConnectionApp.mockReset();
  mocks.toast.success.mockReset();
  mocks.disconnectConnection.mockResolvedValue({ ok: true, revoked: true });
  mocks.removeConnectionApp.mockResolvedValue({ ok: true });
  mocks.listMyConnections.mockResolvedValue({
    connections: [
      {
        id: "conn_1",
        providerId: "google-workspace",
        providerName: "Google Workspace",
        userId: "user_1",
        userEmail: "ada@acme.com",
        apps: [
          { rowId: "app_mail", id: "openmail", name: "OpenMail" },
          { rowId: "app_seo", id: "openseo", name: "OpenSEO" },
        ],
        label: "ada@acme.com",
        scopes: ["gmail.modify", "gmail.send", "webmasters.readonly"],
        status: "active",
        needsReconnect: false,
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
      },
      {
        id: "conn_2",
        providerId: "github-oauth",
        providerName: "GitHub",
        userId: "user_1",
        userEmail: "ada@acme.com",
        apps: [],
        label: "ada",
        scopes: ["repo"],
        status: "expired",
        needsReconnect: false,
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

/** A row's cells, by the provider the account is at. */
function rowFor(provider: string): string[] {
  const row = [...container.querySelectorAll("tbody tr")].find((element) =>
    element.textContent?.includes(provider),
  );
  if (!row) throw new Error(`no row for ${provider}`);
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

/** Press the open confirmation's button. */
async function confirm(label: string) {
  const dialog = document.body.querySelector(
    '[role="alertdialog"], [role="dialog"]',
  )!;
  const button = [...dialog.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  )!;
  await act(async () => button.click());
  await settle();
}

describe("Connected accounts", () => {
  it("lists each connection once with its account, the apps allowed to use it and its scopes, and no way to connect here", async () => {
    await render();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(rowFor("Google Workspace").slice(0, 3)).toEqual([
      "Google Workspaceada@acme.comUsed byOpenMailOpenSEO",
      "gmail.modify, gmail.send, webmasters.readonly",
      "Connected",
    ]);
    expect(rowFor("GitHub").slice(0, 3)).toEqual([
      "GitHubadaNo app can use it yet.",
      "repo",
      "Expired",
    ]);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(body()).not.toMatch(/Connect Google|background|organization/i);
  });

  it("takes one app's access away by the connection's id and the app's row id, then lists again", async () => {
    await render();
    const remove = container.querySelector<HTMLElement>(
      `tbody [aria-label="Remove OpenSEO's access"]`,
    )!;
    await act(async () => remove.click());
    await settle();
    expect(body()).toContain("Remove OpenSEO's access to Google Workspace?");
    expect(mocks.removeConnectionApp).not.toHaveBeenCalled();
    await confirm("Remove access");
    expect(mocks.removeConnectionApp).toHaveBeenCalledOnce();
    expect(mocks.removeConnectionApp.mock.calls[0]![0]).toEqual({
      data: { connectionId: "conn_1", appRowId: "app_seo" },
    });
    expect(mocks.disconnectConnection).not.toHaveBeenCalled();
    expect(mocks.listMyConnections).toHaveBeenCalledTimes(2);
    expect(mocks.toast.success).toHaveBeenCalledWith("Access removed");
  });

  it("disconnects one connection by its id, and says every app stops", async () => {
    await render();
    await pressRowAction("Google Workspace", "Disconnect");
    expect(body()).toContain("Disconnect Google Workspace?");
    expect(body()).toContain("Every app stops using this account at once.");
    await confirm("Disconnect");
    expect(mocks.disconnectConnection).toHaveBeenCalledOnce();
    expect(mocks.disconnectConnection.mock.calls[0]![0]).toEqual({
      data: { connectionId: "conn_1" },
    });
    expect(mocks.removeConnectionApp).not.toHaveBeenCalled();
  });

  it("says so when there is nothing connected", async () => {
    mocks.listMyConnections.mockResolvedValue({ connections: [] });
    await render();
    expect(body()).toContain("No connected accounts yet");
    expect(body()).toContain("Connect one from inside an app.");
  });
});
