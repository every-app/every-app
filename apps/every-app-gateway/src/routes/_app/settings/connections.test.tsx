// @vitest-environment happy-dom
/**
 * Settings → AI connections rendered for real with the server functions
 * mocked: AI apps in the first table, native apps under "Apps on your
 * devices" with the one app each opens, and signing one out revokes that
 * connection by id (the server function scopes it to the signed-in user).
 * The section is absent until there is a native app.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMyMcpConnections: vi.fn(),
  revokeMyMcpConnection: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({ options }),
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/serverFunctions/mcpConnections", () => ({
  listMyMcpConnections: mocks.listMyMcpConnections,
  revokeMyMcpConnection: mocks.revokeMyMcpConnection,
}));
vi.mock("@/client/auth-client", () => ({
  authClient: { useActiveMemberRole: () => ({ data: { role: "member" } }) },
}));
vi.mock("@/client/components/ConnectAgent", () => ({
  ConnectAgentSteps: () => null,
  ConnectAgentDocsLink: () => null,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { Route } from "./connections";

const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE = {
  id: "mcpc_claude",
  kind: "mcp",
  app: null,
  organizationName: "Acme",
  clientName: "Claude",
  clientDomain: "claude.ai",
  redirectHost: "claude.ai",
  apps: "all",
  access: "read",
  createdAt: "2026-10-20T10:00:00.000Z",
  lastUsedAt: null,
};

const OPENZEN = {
  id: "mcpc_openzen",
  kind: "native",
  app: { name: "OpenZen", hostname: "openzen.example.com" },
  organizationName: "Acme",
  clientName: "OpenZen for Mac",
  clientDomain: null,
  redirectHost: "127.0.0.1",
  apps: ["OpenZen"],
  access: "write",
  createdAt: "2026-10-25T10:00:00.000Z",
  lastUsedAt: "2026-10-26T10:00:00.000Z",
};

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

function section(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
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

function dialogButton(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (element) =>
      element.closest('[role="dialog"], [role="alertdialog"]') &&
      element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button in a dialog`);
  return found;
}

beforeEach(() => {
  mocks.listMyMcpConnections.mockReset();
  mocks.revokeMyMcpConnection.mockReset();
  mocks.revokeMyMcpConnection.mockResolvedValue({ ok: true });
  mocks.listMyMcpConnections.mockResolvedValue({
    connections: [CLAUDE, OPENZEN],
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

describe("Apps on your devices", () => {
  it("lists native apps apart from AI apps, with the app each opens", async () => {
    await render();
    const devices = section("Apps on your devices");
    expect(devices).not.toBeNull();
    const devicesText = devices!.textContent ?? "";
    expect(devicesText).toContain("OpenZen for Mac");
    expect(devicesText).toContain("openzen.example.com");
    expect(devicesText).toContain("Unverified");
    expect(devicesText).not.toContain("Claude");

    // The AI apps table, outside the section, keeps Claude only.
    const outside = [...container.querySelectorAll("table")].filter(
      (table) => !devices!.contains(table),
    );
    const outsideText = outside.map((table) => table.textContent).join(" ");
    expect(outsideText).toContain("Claude");
    expect(outsideText).not.toContain("OpenZen for Mac");
  });

  it("is absent until a native app has signed in", async () => {
    mocks.listMyMcpConnections.mockResolvedValue({ connections: [CLAUDE] });
    await render();
    expect(section("Apps on your devices")).toBeNull();
  });

  it("signs a native app out by revoking its connection", async () => {
    await render();
    await pressRowAction("OpenZen for Mac", "Sign out");
    expect(document.body.textContent).toContain("Sign OpenZen for Mac out?");
    await act(async () => dialogButton("Sign out").click());
    await settle();
    expect(mocks.revokeMyMcpConnection).toHaveBeenCalledTimes(1);
    expect(mocks.revokeMyMcpConnection.mock.calls[0]![0]).toEqual({
      data: { connectionId: "mcpc_openzen" },
    });
    expect(mocks.toast.success).toHaveBeenCalled();
  });
});
