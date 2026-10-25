// @vitest-environment happy-dom
/**
 * The MCP app edit dialog rendered for real (React in a DOM): it shows
 * the server, where its credential stands, its status and every tool the
 * server listed with its risk and that risk's source; a per-tool risk or
 * switch changes the effective risk at once and Save sends the whole
 * override map; Turn off and Refresh tools call their server functions.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpAppDetails } from "@/types/mcpApp";

const mocks = vi.hoisted(() => ({
  details: null as McpAppDetails | null,
  getMcpApp: vi.fn(),
  updateRemoteMcpApp: vi.fn(async () => ({})),
  setMcpAppStatus: vi.fn(async () => ({ status: "disabled", changed: true })),
  refreshMcpAppTools: vi.fn(),
}));
vi.mock("@/serverFunctions/mcpApps", () => ({
  getMcpApp: mocks.getMcpApp,
  updateRemoteMcpApp: mocks.updateRemoteMcpApp,
  setMcpAppStatus: mocks.setMcpAppStatus,
  refreshMcpAppTools: mocks.refreshMcpAppTools,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { McpAppEditDialog } from "./McpAppEditDialog";

const COPY = MCP_APP_COPY.edit;
const ROW = "11111111-1111-4111-8111-111111111111";

function details(overrides: Partial<McpAppDetails> = {}): McpAppDetails {
  return {
    id: ROW,
    appId: "treg",
    name: "Treg",
    description: "Treg's notes.",
    status: "active",
    kind: "remote",
    remote: {
      url: "https://treg.to/mcp/",
      auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
      risk: "annotations",
      tools: { getUser: { enabled: false } },
      rev: 2,
    },
    origin: "https://treg.to",
    authKind: "bearer",
    authLabel: "bearer token",
    credential: {
      name: "TREG_MCP_TOKEN",
      set: true,
      boundTo: "https://treg.to",
      state: "bound",
    },
    setupCommand: null,
    snapshot: {
      status: "ok",
      fetchedAt: new Date("2026-10-25T09:00:00Z"),
      lastError: null,
      toolCount: 2,
    },
    tools: [
      {
        upstreamName: "create_note",
        localName: "create_note",
        listedName: "treg_create_note",
        title: "Create a note",
        riskHint: "unknown",
        risk: "write",
        source: "default",
        enabled: true,
        listed: true,
        problem: null,
      },
      {
        upstreamName: "getUser",
        localName: "get_user",
        listedName: "treg_get_user",
        title: null,
        riskHint: "read",
        risk: "read",
        source: "hint",
        enabled: false,
        listed: false,
        problem: "turned off",
      },
      {
        upstreamName: "get-user",
        localName: null,
        listedName: null,
        title: null,
        riskHint: "read",
        risk: "read",
        source: "hint",
        enabled: true,
        listed: false,
        problem: 'skipped: two tools normalize to "get_user"',
      },
    ],
    ...overrides,
  };
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onClose: ReturnType<typeof vi.fn>;
let onChanged: ReturnType<typeof vi.fn>;

async function settle() {
  for (let tick = 0; tick < 5; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

async function render(shown: McpAppDetails = details()) {
  mocks.details = shown;
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <McpAppEditDialog
          app={{ id: ROW, name: "Treg", appId: "treg" }}
          onClose={onClose}
          onChanged={onChanged}
        />
      </QueryClientProvider>,
    ),
  );
  for (let tick = 0; tick < 10; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    if (document.body.textContent?.includes(COPY.columns.serverName)) return;
    if (document.body.textContent?.includes(COPY.noTools)) return;
    if (document.body.textContent?.includes(COPY.noToolsNeedsCredential))
      return;
  }
  throw new Error("the dialog never loaded the app");
}

beforeEach(() => {
  mocks.getMcpApp.mockReset();
  mocks.getMcpApp.mockImplementation(async () => mocks.details);
  mocks.updateRemoteMcpApp.mockClear();
  mocks.setMcpAppStatus.mockClear();
  mocks.refreshMcpAppTools.mockReset();
  onClose = vi.fn();
  onChanged = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = () => dialog().textContent ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

function toolRow(upstreamName: string): HTMLElement {
  const row = dialog().querySelector<HTMLElement>(
    `[data-tool="${upstreamName}"]`,
  );
  if (!row) throw new Error(`no row for ${upstreamName}`);
  return row;
}

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function chooseRisk(upstreamName: string, option: string) {
  const trigger = dialog().querySelector<HTMLElement>(
    `[aria-label="${COPY.toolRiskLabel(upstreamName)}"]`,
  )!;
  await act(async () => trigger.click());
  await settle();
  const item = [...document.querySelectorAll('[role="option"]')].find(
    (element) => element.textContent?.trim() === option,
  ) as HTMLElement | undefined;
  if (!item) throw new Error(`no ${option} option`);
  await press(item);
}

describe("the MCP app edit dialog", () => {
  it("shows the server, the credential, the status and every tool with its risk's source", async () => {
    await render();
    expect(mocks.getMcpApp).toHaveBeenCalledWith({ data: { id: ROW } });
    expect(text()).toContain(COPY.title("Treg"));
    expect(text()).toContain("https://treg.to/mcp/");
    expect(text()).toContain("bearer token");
    expect(text()).toContain(
      COPY.credential.bound("TREG_MCP_TOKEN", "https://treg.to"),
    );
    expect(text()).toContain(COPY.on);
    expect(button(COPY.turnOff)).toBeTruthy();

    const create = toolRow("create_note");
    expect(create.textContent).toContain("treg_create_note");
    expect(create.textContent).toContain("Create a note");
    expect(
      create.querySelector('[data-testid="effective-risk"]')?.textContent,
    ).toBe(COPY.effective("write", "default"));
    expect(
      toolRow("getUser").querySelector('[data-testid="effective-risk"]')
        ?.textContent,
    ).toBe(COPY.effective("read", "hint"));
    // Off by the operator's override: the switch says so.
    expect(
      toolRow("getUser")
        .querySelector('[role="switch"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    const collided = toolRow("get-user");
    expect(collided.textContent).toContain(COPY.notListed);
    expect(collided.textContent).toContain(
      'skipped: two tools normalize to "get_user"',
    );
  });

  it("changes a tool's risk and switch at once, and Save sends the whole override map", async () => {
    await render();
    await chooseRisk("create_note", "Read");
    expect(
      toolRow("create_note").querySelector('[data-testid="effective-risk"]')
        ?.textContent,
    ).toBe(COPY.effective("read", "override"));
    // Turn getUser back on, create_note off.
    await press(
      toolRow("getUser").querySelector<HTMLElement>('[role="switch"]')!,
    );
    await press(
      toolRow("create_note").querySelector<HTMLElement>('[role="switch"]')!,
    );
    await press(button(COPY.save));
    expect(mocks.updateRemoteMcpApp).toHaveBeenCalledWith({
      data: {
        id: ROW,
        tools: { create_note: { risk: "read", enabled: false } },
      },
    });
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reads every tool by the app's default once it is Everything write", async () => {
    await render();
    const riskField = [...dialog().querySelectorAll("label")].find(
      (label) => label.textContent === COPY.riskLabel,
    )!;
    await press(document.getElementById(riskField.getAttribute("for")!)!);
    const item = [...document.querySelectorAll('[role="option"]')].find(
      (element) => element.textContent?.trim() === "Everything write",
    ) as HTMLElement;
    await press(item);
    expect(
      toolRow("getUser").querySelector('[data-testid="effective-risk"]')
        ?.textContent,
    ).toBe(COPY.effective("write", "app"));
    await press(button(COPY.save));
    expect(mocks.updateRemoteMcpApp).toHaveBeenCalledWith({
      data: { id: ROW, risk: "write" },
    });
  });

  it("closes without a write when nothing changed", async () => {
    await render();
    await press(button(COPY.save));
    expect(mocks.updateRemoteMcpApp).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("turns the app off, and reads it again", async () => {
    await render();
    await press(button(COPY.turnOff));
    expect(mocks.setMcpAppStatus).toHaveBeenCalledWith({
      data: { id: ROW, status: "disabled" },
    });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(mocks.getMcpApp.mock.calls.length).toBeGreaterThan(1);
  });

  it("turns an app that is off on", async () => {
    await render(details({ status: "disabled" }));
    expect(text()).toContain(COPY.off);
    await press(button(COPY.turnOn));
    expect(mocks.setMcpAppStatus).toHaveBeenCalledWith({
      data: { id: ROW, status: "active" },
    });
  });

  it("refreshes the tools and says what came and went", async () => {
    mocks.refreshMcpAppTools.mockResolvedValue({
      status: "ok",
      toolCount: 2,
      added: ["treg_search"],
      removed: ["treg_create_note"],
      error: null,
    });
    await render();
    await press(button(COPY.refresh));
    expect(mocks.refreshMcpAppTools).toHaveBeenCalledWith({
      data: { id: ROW },
    });
    const status = dialog().querySelector('[role="status"]')?.textContent;
    expect(status).toBe(
      `${COPY.refreshAdded(["treg_search"])} ${COPY.refreshRemoved(["treg_create_note"])}`,
    );
  });

  it("shows the command for a credential that isn't set, and no tools until it is", async () => {
    await render(
      details({
        credential: {
          name: "TREG_MCP_TOKEN",
          set: false,
          boundTo: null,
          state: "not_set",
        },
        setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
        snapshot: {
          status: null,
          fetchedAt: null,
          lastError: null,
          toolCount: 0,
        },
        tools: [],
      }),
    );
    expect(text()).toContain(COPY.credential.not_set("TREG_MCP_TOKEN"));
    expect(dialog().querySelector("code")?.textContent).toBe(
      "pnpm everyapp secret set TREG_MCP_TOKEN",
    );
    expect(text()).toContain(COPY.neverListed);
    expect(text()).toContain(COPY.noToolsNeedsCredential);
  });
});
