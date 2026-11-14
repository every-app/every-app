// @vitest-environment happy-dom
/**
 * The Composio page rendered for real with the server functions mocked:
 * it shows the step its context names, loads the context again once the
 * person signed in to Composio or pressed Check again, and shows what
 * comes next; a context that can't go ahead shows its message, and a
 * signed-out visitor is sent to sign in and back.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposioLinkState, ComposioPageStep } from "@/schemas/composio";

const mocks = vi.hoisted(() => ({
  getComposioContext: vi.fn(),
  startComposioLink: vi.fn(),
  finishComposioLink: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({ options }),
}));
vi.mock("@/serverFunctions/composio", () => ({
  getComposioContext: mocks.getComposioContext,
  startComposioLink: mocks.startComposioLink,
  finishComposioLink: mocks.finishComposioLink,
}));
vi.mock("@/client/sign-in-methods", () => ({
  useSignInMethods: () => ({ data: undefined }),
}));
vi.mock("@/client/sign-out", () => ({ signOutAndForget: vi.fn() }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { COMPOSIO_CHECK_MS } from "@/client/hooks/useComposioLink";
import { Route } from "./composio";

const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

const BASE = {
  ok: true,
  state: "state-1",
  action: "/connect/google-workspace/composio",
  email: "ada@acme.com",
  provider: { id: "google-workspace", name: "Google Workspace" },
  app: {
    id: "openmail",
    name: "OpenMail",
    hostname: null,
    status: "active",
    icon: null,
  },
  why: null,
};
const LINK = { ...BASE, step: ComposioPageStep.Link };
const MISSING = {
  ...BASE,
  step: ComposioPageStep.Missing,
  missing: [
    {
      slug: "gmail",
      label: "Gmail",
      url: "https://dashboard.composio.dev/~/~/connect/apps/gmail",
    },
  ],
};
const ALLOW = {
  ...BASE,
  step: ComposioPageStep.Allow,
  services: [
    {
      slug: "gmail",
      label: "Gmail",
      accounts: [{ id: "ca_gmail", account: "ada@gmail.com" }],
      chosen: "ca_gmail",
    },
  ],
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function render() {
  act(() => root.render(<Page />));
  await flush();
}

const title = () => document.body.querySelector("h1")?.textContent;
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of [
    mocks.getComposioContext,
    mocks.startComposioLink,
    mocks.finishComposioLink,
  ]) {
    fn.mockReset();
  }
  window.history.replaceState(null, "", "/oauth/composio?state=state-1");
  vi.spyOn(window, "open").mockReturnValue(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the Composio page", () => {
  it("asks for the context of the state in its address", async () => {
    mocks.getComposioContext.mockResolvedValue(ALLOW);
    await render();
    expect(mocks.getComposioContext.mock.calls).toEqual([
      [{ data: { state: "state-1" } }],
    ]);
    expect(title()).toBe(
      "Allow OpenMail to use your Google Workspace account from Composio?",
    );
  });

  it("waits for the sign-in at Composio, then loads again and shows what comes next", async () => {
    mocks.getComposioContext.mockResolvedValue(LINK);
    mocks.startComposioLink.mockResolvedValue({
      url: "https://dashboard.composio.dev/cli/sign-in/abc",
      expiresAt: Date.now() + 600_000,
    });
    mocks.finishComposioLink.mockResolvedValue({
      state: ComposioLinkState.Linked,
    });
    await render();
    expect(title()).toBe(
      "Sign in to Composio to use your Google Workspace account in OpenMail",
    );
    act(() => button("Sign in to Composio").click());
    await flush();
    expect(text()).toContain("Approve the sign-in at Composio.");

    mocks.getComposioContext.mockResolvedValue(MISSING);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPOSIO_CHECK_MS);
    });
    expect(mocks.getComposioContext).toHaveBeenCalledTimes(2);
    expect(title()).toBe("Gmail isn't connected in your Composio");
  });

  it("checks again, and asks once the service is connected", async () => {
    mocks.getComposioContext.mockResolvedValue(MISSING);
    await render();
    mocks.getComposioContext.mockResolvedValue(ALLOW);
    act(() => button("Check again").click());
    await flush();
    expect(mocks.getComposioContext).toHaveBeenCalledTimes(2);
    expect(title()).toBe(
      "Allow OpenMail to use your Google Workspace account from Composio?",
    );
  });

  it("shows why a request can't go ahead", async () => {
    mocks.getComposioContext.mockResolvedValue({
      ok: false,
      message: "This page was used already or expired. Open the app again.",
    });
    await render();
    expect(title()).toBe("Can't connect this account");
    expect(text()).toContain(
      "This page was used already or expired. Open the app again.",
    );
    expect(container.querySelector("form")).toBeNull();
  });

  it("says so when the context can't be loaded", async () => {
    mocks.getComposioContext.mockRejectedValue(new Error("down"));
    await render();
    expect(title()).toBe("Can't connect this account");
    expect(text()).toContain("This request can't be shown.");
  });

  it("sends a signed-out visitor to sign in and back to this page", async () => {
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined);
    mocks.getComposioContext.mockResolvedValue({ ok: false, signedOut: true });
    await render();
    expect(assign).toHaveBeenCalledWith(
      `/sign-in?redirect=${encodeURIComponent("/oauth/composio?state=state-1")}`,
    );
  });
});
