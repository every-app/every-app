// @vitest-environment happy-dom
/**
 * The "Use it from your agent" dialog rendered for real (React in a DOM): the
 * Connect your agent tabs and steps, then the sentence to ask as every client's
 * last step, a close from its footer, and above the steps, for a server members
 * sign in to, whether this person is connected.
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
// The dialog's links are router Links; the test has no router.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { CONNECT_AGENT_COPY } from "@/client/lib/connectAgentCopy";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { McpAppDialog } from "./McpAppDialog";

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

function renderDialog(name: string, appId: string) {
  act(() =>
    root.render(
      <McpAppDialog
        name={name}
        appId={appId}
        role="member"
        onClose={onClose}
      />,
    ),
  );
}

function tab(label: string): HTMLElement {
  const found = [
    ...(dialog()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
  ].find((element) => element.textContent === label);
  if (!found) throw new Error(`no tab ${label}`);
  return found;
}

/** The selected tab's steps: each one's text and what it offers to copy. */
function steps() {
  const selected = dialog()?.querySelector(
    '[role="tab"][aria-selected="true"]',
  );
  const panel = document.getElementById(
    selected?.getAttribute("aria-controls") ?? "",
  );
  return [...(panel?.querySelectorAll("ol > li") ?? [])].map((step) => ({
    text: step.querySelector("p")?.textContent,
    code: step.querySelector("code")?.textContent,
  }));
}

it("ends every client's own steps with what to ask", () => {
  renderDialog("DataForSEO", "dataforseo");
  expect(text()).toContain(MCP_APP_COPY.useDialog.title("DataForSEO"));
  for (const client of CONNECT_AGENT_COPY.clients) {
    act(() => tab(client.label).click());
    const shown = steps();
    expect(shown.map((step) => step.text)).toEqual([
      ...client.steps.map((step) => step.text),
      MCP_APP_COPY.useDialog.ask,
    ]);
    expect(shown.at(-1)?.code).toBe(
      "Use DataForSEO to find keyword ideas for a page about running shoes.",
    );
  }
});

it("starts from this Gateway's own address", () => {
  renderDialog("DataForSEO", "dataforseo");
  expect(steps()[0]?.code).toBe(`${window.location.origin}/mcp`);
});

it("gives a remote MCP server (no built-in example) a generic sentence", () => {
  renderDialog("Treg", "treg");
  expect(steps().at(-1)?.code).toBe(
    "List what Treg offers, then use one of its tools.",
  );
});

it("closes from the footer", () => {
  renderDialog("DataForSEO", "dataforseo");
  const close = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Close",
  );
  if (!close) throw new Error("no Close button");
  act(() => close.click());
  expect(onClose).toHaveBeenCalledOnce();
});

const STATUS: McpAppConnectionStatus = {
  providerName: "Treg MCP server",
  connectPath: "/connect/treg-mcp?app=treg&return=%2Fconnections%2Faccounts",
  connection: null,
};

async function renderTreg(status: McpAppConnectionStatus | null) {
  mocks.getMcpAppConnection.mockResolvedValue(status);
  await act(async () => {
    root.render(
      <McpAppDialog name="Treg" appId="treg" role="member" onClose={onClose} />,
    );
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

function link(label: string) {
  return [...(dialog()?.querySelectorAll("a") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  );
}

it("never asks about a connection for a built-in", () => {
  renderDialog("DataForSEO", "dataforseo");
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
