// @vitest-environment happy-dom
/**
 * The token dialog rendered for real (React in a DOM): what it creates by
 * default, read off the `onCreate` call. Least privilege is the default: a
 * read-only MCP token, for the one app where there is one, for 30 days;
 * full access is an explicit choice (`pat.ui-least-privilege-defaults`).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppWithAccessCount } from "@/types/app";
import { ACCESS_SCOPES, CreateUserTokenModal } from "./CreateUserTokenModal";
import { DAY_MS } from "./tokenExpiry";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const todo = {
  id: "row-todo",
  appId: "todo",
  name: "Todos",
} as unknown as AppWithAccessCount;
const notes = {
  id: "row-notes",
  appId: "notes",
  name: "Notes",
} as unknown as AppWithAccessCount;

let root: Root;
let container: HTMLElement;
let created: Array<{
  name: string;
  appId?: string;
  scopes?: string[];
  expiresAt?: string;
}>;

function render(apps: AppWithAccessCount[]) {
  act(() =>
    root.render(
      <CreateUserTokenModal
        apps={apps}
        onClose={() => undefined}
        onCreate={async (input) => {
          created.push(input);
        }}
      />,
    ),
  );
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = document.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
  // The async submit settles over a few microtasks.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  created = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the token dialog's defaults", () => {
  it("creates a read-only MCP token for the one app, for 30 days", async () => {
    render([todo]);
    const name =
      document.querySelector<HTMLInputElement>('input[name="name"]')!;
    type(name, "Claude Code");
    await submit();

    expect(created).toHaveLength(1);
    const [token] = created;
    expect(token).toMatchObject({
      name: "Claude Code",
      appId: "row-todo",
      scopes: ["mcp:read"],
    });
    const ttl = new Date(token!.expiresAt!).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * DAY_MS);
    expect(ttl).toBeLessThanOrEqual(30 * DAY_MS);
  });

  it("offers every app only as a choice when there are several, still read only", async () => {
    render([notes, todo]);
    type(
      document.querySelector<HTMLInputElement>('input[name="name"]')!,
      "Cursor",
    );
    await submit();
    expect(created[0]).toMatchObject({ scopes: ["mcp:read"] });
    expect(created[0]!.appId).toBeUndefined();
  });

  it("never sends the server's implicit wildcard: full access is the explicit choice", () => {
    expect(ACCESS_SCOPES.read).toEqual(["mcp:read"]);
    expect(ACCESS_SCOPES.write).toEqual(["mcp:write"]);
    expect(ACCESS_SCOPES.full).toEqual(["*"]);
    render([todo]);
    // The dialog opens on the narrow choice; the wider ones are in the
    // closed select.
    expect(document.body.textContent).toContain("Read only");
    expect(document.body.textContent).not.toContain("Full access");
  });
});
