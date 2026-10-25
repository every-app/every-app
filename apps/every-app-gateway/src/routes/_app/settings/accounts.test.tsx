// @vitest-environment happy-dom
/**
 * Settings → Connected accounts rendered for real with the server
 * functions mocked: one row per connectable provider with Connect (a link
 * into the Gateway's flow that returns here), Connected with Disconnect,
 * Reconnect for an expired one; the callback's `?connected=` and
 * `?error=` become one notice; no token is ever on the page.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMyConnections: vi.fn(),
  listConnectableProviders: vi.fn(),
  disconnectConnection: vi.fn(),
  search: {} as Record<string, string>,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({
      options,
      useSearch: () => mocks.search,
    }),
}));
vi.mock("@/serverFunctions/connections", () => ({
  listMyConnections: mocks.listMyConnections,
  listConnectableProviders: mocks.listConnectableProviders,
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
  mocks.listConnectableProviders.mockReset();
  mocks.search = {};
  mocks.listConnectableProviders.mockResolvedValue({
    providers: [
      { id: "github-oauth", name: "GitHub" },
      { id: "google-workspace", name: "Google Workspace" },
      { id: "notion-oauth", name: "Notion" },
    ],
  });
  mocks.listMyConnections.mockResolvedValue({
    connections: [
      {
        id: "conn_1",
        providerId: "github-oauth",
        providerName: "GitHub",
        account: "user",
        userId: "user_1",
        label: "ada",
        scopeSets: ["identity", "repo.read"],
        status: "active",
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
      },
      {
        id: "conn_2",
        providerId: "google-workspace",
        providerName: "Google Workspace",
        account: "user",
        userId: "user_1",
        label: "ada@acme.com",
        scopeSets: ["identity"],
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
});

const body = () => document.body.textContent ?? "";

function link(label: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll("a")].find(
    (element) => element.textContent?.trim() === label,
  );
}

describe("Connected accounts", () => {
  it("shows Connect, Connected with Disconnect, and Reconnect, each into the Gateway's flow", async () => {
    await render();
    expect(body()).toContain("ada · identity, repo.read");
    expect(link("Connect Notion")?.getAttribute("href")).toBe(
      "/connect/notion-oauth?account=user&return=%2Fsettings%2Faccounts",
    );
    expect(link("Reconnect")?.getAttribute("href")).toBe(
      "/connect/google-workspace?account=user&return=%2Fsettings%2Faccounts",
    );
    expect(link("Connect GitHub")).toBeUndefined();
    expect(
      container.querySelector('button[aria-label="Disconnect GitHub"]'),
    ).not.toBeNull();
    expect(body()).toContain("Needs reconnecting");
  });

  it("turns the callback's return into one notice", async () => {
    mocks.search = { connected: "GitHub" };
    await render();
    expect(body()).toContain("GitHub connected.");
  });

  it("says why a connect failed, in plain words", async () => {
    mocks.search = { error: "access_denied" };
    await render();
    expect(body()).toContain("You cancelled at the provider");
  });
});
