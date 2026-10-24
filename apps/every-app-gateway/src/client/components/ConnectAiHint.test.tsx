// @vitest-environment happy-dom
/**
 * The way in under the empty AI connections list, rendered for real (React
 * in a DOM): the gateway's own /mcp address, the docs link, and a tokens
 * line that fits the reader's role, since members cannot open /admin.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectAiHint } from "./ConnectAiHint";

// The tokens line is a router Link; the test has no router.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
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

function render(role: string | undefined) {
  act(() => root.render(<ConnectAiHint role={role} />));
  return container;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectAiHint", () => {
  it("shows the gateway's own /mcp address with a copy button and the docs", () => {
    const host = render("member");
    const address = `${window.location.origin}/mcp`;
    expect(host.querySelector("code")?.textContent).toBe(address);
    expect(host.querySelector("button")?.textContent).toBe("Copy");
    const docs = host.querySelector('a[target="_blank"]');
    expect(docs?.getAttribute("href")).toBe(
      "https://everyapp.com/docs/connect-ai",
    );
    expect(docs?.textContent).toContain("How to connect an AI app");
  });

  it.each(["owner", "admin"])(
    "sends an %s to Manage workspace → Tokens",
    (role) => {
      const host = render(role);
      const tokens = host.querySelector('a[href="/admin/tokens"]');
      expect(tokens?.textContent).toBe("Manage workspace → Tokens");
      expect(host.textContent).toContain(
        "Scripts and tools that can't sign in use a personal access token",
      );
    },
  );

  it("tells a member to ask, with no link to the admin pages", () => {
    const host = render("member");
    expect(host.querySelector('a[href="/admin/tokens"]')).toBeNull();
    expect(host.textContent).toContain(
      "Ask an owner or admin for a personal access token if a tool can't sign in.",
    );
  });

  it("says nothing about tokens while the role is unknown", () => {
    const host = render(undefined);
    expect(host.textContent).not.toContain("personal access token");
    expect(host.querySelector("code")).not.toBeNull();
  });
});
