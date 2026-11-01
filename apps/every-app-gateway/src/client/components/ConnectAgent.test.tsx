// @vitest-environment happy-dom
/**
 * "Connect your agent", rendered for real (React in a DOM): the gateway's
 * own /mcp address, a tab per client whose command carries that address, a
 * tokens line that fits the reader's role (members cannot open /admin), and
 * the dialog's way to the connections list and the docs.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_AGENT_COPY } from "@/client/lib/connectAgentCopy";
import { ConnectAgentDialog, ConnectAgentSteps } from "./ConnectAgent";

// The links are router Links; the test has no router.
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

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
const address = () => `${window.location.origin}/mcp`;

function render(node: React.ReactNode) {
  act(() => root.render(node));
  return document.body;
}

function tab(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="tab"]'),
  ].find((element) => element.textContent === label);
  if (!found) throw new Error(`no tab ${label}`);
  return found;
}

/** The selected tab's panel (a closing panel can linger in the DOM). */
function panelText(): string {
  const selected = document.querySelector('[role="tab"][aria-selected="true"]');
  const id = selected?.getAttribute("aria-controls");
  return (id && document.getElementById(id)?.textContent) || "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("ConnectAgentSteps", () => {
  it("shows the gateway's own /mcp address to copy", () => {
    const host = render(<ConnectAgentSteps role="member" />);
    expect(host.querySelector("code")?.textContent).toBe(address());
    expect(
      host.querySelector('button[aria-label="Copy to clipboard"]'),
    ).not.toBeNull();
  });

  it("has a tab per client, each command naming this gateway's address", () => {
    render(<ConnectAgentSteps role="member" />);
    expect(
      [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent),
    ).toEqual(CONNECT_AGENT_COPY.clients.map((client) => client.label));
    expect(panelText()).toContain("custom connector");

    act(() => tab("Claude Code").click());
    expect(panelText()).toContain(
      `claude mcp add --transport http everyapp ${address()}`,
    );
    act(() => tab("Codex").click());
    expect(panelText()).toContain(`codex mcp add everyapp --url ${address()}`);
    expect(panelText()).toContain("codex mcp login everyapp");
    act(() => tab("Cursor").click());
    expect(panelText()).toContain(`"url": "${address()}"`);
  });

  it("sends owners and admins to Tokens and tells members to ask", () => {
    let host = render(<ConnectAgentSteps role="admin" />);
    expect(host.querySelector('a[href="/admin/tokens"]')).not.toBeNull();

    host = render(<ConnectAgentSteps role="member" />);
    expect(host.querySelector('a[href="/admin/tokens"]')).toBeNull();
    expect(host.textContent).toContain(CONNECT_AGENT_COPY.token.member);

    host = render(<ConnectAgentSteps role={undefined} />);
    expect(host.textContent).not.toContain("personal access token");
  });
});

describe("ConnectAgentDialog", () => {
  it("links to the connections list and the docs, and closes on leaving", () => {
    const onClose = vi.fn();
    render(<ConnectAgentDialog role="member" onClose={onClose} />);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(CONNECT_AGENT_COPY.title);
    const connections = dialog?.querySelector<HTMLAnchorElement>(
      'a[href="/settings/connections"]',
    );
    expect(
      dialog?.querySelector('a[href="https://everyapp.com/docs/connect-ai"]'),
    ).not.toBeNull();
    act(() => connections?.click());
    expect(onClose).toHaveBeenCalled();
  });
});
