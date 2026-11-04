// @vitest-environment happy-dom
/**
 * The "Use it from your agent" dialog rendered for real (React in a DOM):
 * it shows this Gateway's own MCP address with a copy button, the app's
 * tool prefix, the provider's example sentence and the two docs links,
 * and closes from its footer.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpAppConnectionStatus } from "@/types/mcpApp";

const mocks = vi.hoisted(() => ({
  getMcpAppConnection: vi.fn(
    async (): Promise<McpAppConnectionStatus | null> => null,
  ),
}));
vi.mock("@/serverFunctions/mcpApps", () => ({
  getMcpAppConnection: mocks.getMcpAppConnection,
}));

import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { CONNECT_AI_DOCS_URL } from "@/client/lib/connectAgentCopy";
import { MCP_APPS_DOCS_URL, McpAppDialog } from "./McpAppDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.getMcpAppConnection.mockReset();
  mocks.getMcpAppConnection.mockResolvedValue(null);
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

it("says where the app is reached and what to say, with the docs to go on with", () => {
  act(() =>
    root.render(
      <McpAppDialog name="DataForSEO" appId="dataforseo" onClose={onClose} />,
    ),
  );
  expect(text()).toContain("Use DataForSEO from your agent");
  expect(text()).toContain("DataForSEO has no page.");
  // The address is this origin's, read on the client.
  expect(dialog()?.querySelector("code")?.textContent).toBe(
    `${window.location.origin}/mcp`,
  );
  expect(
    dialog()?.querySelector('[aria-label="Copy to clipboard"]'),
  ).not.toBeNull();
  expect(text()).toContain("Its tools start with dataforseo_. Try saying:");
  expect(text()).toContain(
    "“Use DataForSEO to find keyword ideas for a page about running shoes.”",
  );
  const links = [...(dialog()?.querySelectorAll("a[href]") ?? [])].map((link) =>
    link.getAttribute("href"),
  );
  expect(links).toEqual([CONNECT_AI_DOCS_URL, MCP_APPS_DOCS_URL]);
});

it("closes from the footer", () => {
  act(() =>
    root.render(
      <McpAppDialog name="DataForSEO" appId="dataforseo" onClose={onClose} />,
    ),
  );
  const close = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Close",
  );
  if (!close) throw new Error("no Close button");
  act(() => close.click());
  expect(onClose).toHaveBeenCalledOnce();
});

it("gives a remote MCP server (no built-in example) a generic sentence", () => {
  act(() =>
    root.render(<McpAppDialog name="Treg" appId="treg" onClose={onClose} />),
  );
  expect(text()).toContain("Its tools start with treg_. Try saying:");
  expect(text()).toContain(
    `“${MCP_APP_COPY.useDialog.genericExample("Treg")}”`,
  );
  expect(text()).toContain(
    "“List what Treg offers, then use one of its tools.”",
  );
  expect(text()).not.toContain("Use Treg to");
});

const STATUS: McpAppConnectionStatus = {
  providerName: "Treg MCP server",
  connectPath: "/connect/treg-mcp?app=treg&return=%2F%3Fmcp%3Dtreg",
  connection: null,
};

async function renderTreg(status: McpAppConnectionStatus | null) {
  mocks.getMcpAppConnection.mockResolvedValue(status);
  await act(async () => {
    root.render(<McpAppDialog name="Treg" appId="treg" onClose={onClose} />);
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

function link(label: string) {
  return [...(dialog()?.querySelectorAll("a") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  );
}

it("never asks about a connection for a built-in", () => {
  act(() =>
    root.render(
      <McpAppDialog name="DataForSEO" appId="dataforseo" onClose={onClose} />,
    ),
  );
  expect(mocks.getMcpAppConnection).not.toHaveBeenCalled();
});

it("links a member to connect their own account to an OAuth MCP app", async () => {
  await renderTreg(STATUS);
  expect(mocks.getMcpAppConnection).toHaveBeenCalledWith({
    data: { appId: "treg" },
  });
  expect(
    link(MCP_APP_COPY.useDialog.connect("Treg MCP server"))?.getAttribute(
      "href",
    ),
  ).toBe(STATUS.connectPath);
});

it("says who is connected, and offers Reconnect once it expired", async () => {
  await renderTreg({
    ...STATUS,
    connection: { status: "active", label: "ben@example.com" },
  });
  expect(text()).toContain(
    MCP_APP_COPY.useDialog.connectedAs("ben@example.com"),
  );
  act(() => root.unmount());
  root = createRoot(container);
  await renderTreg({
    ...STATUS,
    connection: { status: "expired", label: null },
  });
  expect(text()).toContain(MCP_APP_COPY.useDialog.expired);
  expect(link(MCP_APP_COPY.useDialog.reconnect)).toBeTruthy();
});
