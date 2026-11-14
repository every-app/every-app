// @vitest-environment happy-dom
/**
 * Composio on Your connections → Accounts rendered for real, with the
 * server functions mocked: Link Composio while Composio is on, and for an
 * owner or admin while it is off, whose first step turns it on after
 * saying what that means; the sign-in opened in a new tab at the click,
 * with a link to it kept on the page, and asked about every two seconds
 * until it is approved or expires; then the Composio account's name with
 * Unlink, which confirms first.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { COMPOSIO_IS, COMPOSIO_NOTICE } from "@every-app/sdk/internal";
import { ComposioLinkState } from "@/schemas/composio";

const mocks = vi.hoisted(() => ({
  role: "member" as "owner" | "admin" | "member",
  getComposioStatus: vi.fn(),
  setComposioSwitch: vi.fn(),
  startComposioLink: vi.fn(),
  finishComposioLink: vi.fn(),
  unlinkComposio: vi.fn(),
  listMyConnections: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/serverFunctions/composio", () => ({
  getComposioStatus: mocks.getComposioStatus,
  getComposioSwitch: vi.fn(),
  setComposioSwitch: mocks.setComposioSwitch,
  startComposioLink: mocks.startComposioLink,
  finishComposioLink: mocks.finishComposioLink,
  unlinkComposio: mocks.unlinkComposio,
}));
vi.mock("@/serverFunctions/connections", () => ({
  listMyConnections: mocks.listMyConnections,
}));
vi.mock("@/client/auth-client", () => ({
  authClient: {
    useActiveMemberRole: () => ({ data: { role: mocks.role } }),
  },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { COMPOSIO_CHECK_MS } from "@/client/hooks/useComposioLink";
import { useConnectedAccounts } from "@/client/hooks/useConnectedAccounts";
import { ComposioSection } from "./ComposioSection";

const OFF = { composio: "off", linked: false, account: null, providers: null };
const ON = { ...OFF, composio: "on" };
const LINKED = { ...ON, linked: true, account: "ada@composio.example" };
const SIGN_IN = "https://dashboard.composio.dev/cli/sign-in/abc";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let tab: {
  opener: unknown;
  location: { replace: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
};
let open: MockInstance<typeof window.open>;

/** Let what is under way settle, without reaching the next check. */
async function settle() {
  for (let tick = 0; tick < 6; tick++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

/** Wait until the page asks about the sign-in again. */
async function nextCheck() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(COMPOSIO_CHECK_MS);
  });
  await settle();
}

/** The page's Connected accounts beside the section, to see what a change reads again. */
function Accounts() {
  useConnectedAccounts();
  return null;
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Accounts />
        <ComposioSection />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const text = () => (container.textContent ?? "").replace(/\s+/g, " ");

function button(label: string, scope: Element = container) {
  const found = [...scope.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

const confirmDialog = () =>
  document.body.querySelector<HTMLElement>('[role="alertdialog"]');

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.role = "member";
  for (const fn of Object.values(mocks)) {
    if (typeof fn === "function") fn.mockReset();
  }
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.getComposioStatus.mockResolvedValue(ON);
  mocks.listMyConnections.mockResolvedValue({ connections: [] });
  mocks.startComposioLink.mockResolvedValue({
    url: SIGN_IN,
    expiresAt: Date.now() + 600_000,
  });
  mocks.finishComposioLink.mockResolvedValue({
    state: ComposioLinkState.Waiting,
  });
  mocks.setComposioSwitch.mockResolvedValue({
    composio: "on",
    changed: true,
    removed: { links: 0, connections: 0 },
  });
  mocks.unlinkComposio.mockResolvedValue({ ok: true });
  tab = { opener: window, location: { replace: vi.fn() }, close: vi.fn() };
  open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  open.mockRestore();
  vi.useRealTimers();
});

describe("who sees Composio", () => {
  it("is nobody but an owner or admin while Composio is off", async () => {
    mocks.getComposioStatus.mockResolvedValue(OFF);
    await render();
    expect(text()).toBe("");

    for (const role of ["owner", "admin"] as const) {
      act(() => root.unmount());
      root = createRoot(container);
      mocks.role = role;
      await render();
      expect(button("Link Composio")).toBeTruthy();
    }
  });

  it("is every member while it is on, with what Composio is and a link to how it works", async () => {
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("Composio");
    expect(text()).toContain(`${COMPOSIO_IS} How it works`);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://everyapp.com/docs/composio",
    );
    expect(button("Link Composio")).toBeTruthy();
  });
});

describe("Link Composio", () => {
  it("opens the sign-in at Composio at the click, keeps a link to it, and asks every two seconds until it is approved", async () => {
    mocks.finishComposioLink
      .mockResolvedValueOnce({ state: ComposioLinkState.Waiting })
      .mockResolvedValue({ state: ComposioLinkState.Linked });
    await render();
    act(() => button("Link Composio").click());
    // The tab is opened by the click itself, before the sign-in is known.
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    await settle();
    expect(mocks.setComposioSwitch).not.toHaveBeenCalled();
    expect(mocks.startComposioLink).toHaveBeenCalledOnce();
    expect(tab.location.replace).toHaveBeenCalledWith(SIGN_IN);
    expect(text()).toContain("Approve the sign-in at Composio.");
    const shown = container.querySelector("a")!;
    expect(shown.textContent).toBe("Open Composio");
    expect(shown.getAttribute("href")).toBe(SIGN_IN);
    expect(shown.target).toBe("_blank");
    expect(shown.rel).toBe("noopener noreferrer");

    expect(mocks.finishComposioLink).not.toHaveBeenCalled();
    await nextCheck();
    expect(mocks.finishComposioLink).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a")).not.toBeNull();

    mocks.getComposioStatus.mockResolvedValue(LINKED);
    await nextCheck();
    expect(mocks.finishComposioLink).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Linked as ada@composio.example.");
    expect(button("Unlink")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    // Linking adds nothing to Connected accounts: they aren't read again.
    expect(mocks.listMyConnections).toHaveBeenCalledOnce();
    // And nothing asks any more.
    await nextCheck();
    expect(mocks.finishComposioLink).toHaveBeenCalledTimes(2);
  });

  it("says the sign-in expired, and starts another", async () => {
    mocks.finishComposioLink.mockResolvedValue({
      state: ComposioLinkState.Expired,
    });
    await render();
    await press(button("Link Composio"));
    await nextCheck();
    expect(text()).toContain("The sign-in expired.");
    expect(text()).not.toContain(COMPOSIO_IS);
    expect(container.querySelector("a")).toBeNull();
    await nextCheck();
    expect(mocks.finishComposioLink).toHaveBeenCalledOnce();

    await press(button("Link Composio"));
    expect(mocks.startComposioLink).toHaveBeenCalledTimes(2);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(SIGN_IN);
  });

  it("closes the tab and says why when the sign-in can't start", async () => {
    mocks.startComposioLink.mockRejectedValue(
      Object.assign(new Error("COMPOSIO_UNAVAILABLE"), {
        code: "COMPOSIO_UNAVAILABLE",
      }),
    );
    await render();
    await press(button("Link Composio"));
    expect(tab.close).toHaveBeenCalledOnce();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Composio could not be reached. Try again.",
    );
    expect(button("Link Composio")).toBeTruthy();
    await nextCheck();
    expect(mocks.finishComposioLink).not.toHaveBeenCalled();
  });

  it("stops waiting and says why when the link can't be finished", async () => {
    mocks.finishComposioLink.mockRejectedValue(
      Object.assign(new Error("COMPOSIO_LINK_FAILED"), {
        code: "COMPOSIO_LINK_FAILED",
      }),
    );
    await render();
    await press(button("Link Composio"));
    await nextCheck();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Composio approved the sign-in, but the link could not be finished. Start again.",
    );
    expect(button("Link Composio")).toBeTruthy();
    await nextCheck();
    expect(mocks.finishComposioLink).toHaveBeenCalledOnce();
  });
});

describe("an owner or admin while Composio is off", () => {
  beforeEach(() => {
    mocks.role = "owner";
    mocks.getComposioStatus.mockResolvedValue(OFF);
  });

  it("is told what turning Composio on means before the link starts", async () => {
    await render();
    await press(button("Link Composio"));
    expect(confirmDialog()?.textContent).toContain("Turn on Composio?");
    expect(confirmDialog()?.textContent).toContain(COMPOSIO_IS);
    expect(confirmDialog()?.textContent).toContain(COMPOSIO_NOTICE);
    expect(open).not.toHaveBeenCalled();
    expect(mocks.setComposioSwitch).not.toHaveBeenCalled();
    expect(mocks.startComposioLink).not.toHaveBeenCalled();

    mocks.getComposioStatus.mockResolvedValue(ON);
    const order: string[] = [];
    mocks.setComposioSwitch.mockImplementation(async () => {
      order.push("on");
      return { composio: "on", changed: true };
    });
    mocks.startComposioLink.mockImplementation(async () => {
      order.push("link");
      return { url: SIGN_IN, expiresAt: Date.now() + 600_000 };
    });
    act(() => button("Turn on and link", confirmDialog()!).click());
    // The tab opens at this click: it is the one that starts the sign-in.
    expect(open).toHaveBeenCalledWith("", "_blank");
    await settle();
    expect(mocks.setComposioSwitch.mock.calls).toEqual([
      [{ data: { on: true } }],
    ]);
    expect(order).toEqual(["on", "link"]);
    expect(confirmDialog()).toBeNull();
    expect(tab.location.replace).toHaveBeenCalledWith(SIGN_IN);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(SIGN_IN);
  });

  it("starts nothing when they cancel", async () => {
    await render();
    await press(button("Link Composio"));
    await press(button("Cancel", confirmDialog()!));
    expect(confirmDialog()).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(mocks.setComposioSwitch).not.toHaveBeenCalled();
    expect(mocks.startComposioLink).not.toHaveBeenCalled();
  });

  it("starts no sign-in when Composio can't be turned on", async () => {
    mocks.setComposioSwitch.mockRejectedValue(
      Object.assign(new Error("ADMIN_REQUIRED"), { code: "ADMIN_REQUIRED" }),
    );
    await render();
    await press(button("Link Composio"));
    await press(button("Turn on and link", confirmDialog()!));
    expect(mocks.startComposioLink).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalledOnce();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Only an owner or admin can do that.",
    );
  });
});

describe("someone who linked their Composio", () => {
  beforeEach(() => {
    mocks.getComposioStatus.mockResolvedValue(LINKED);
  });

  it("sees the Composio account's name with Unlink, and no way to link again", async () => {
    await render();
    expect(text()).toContain("Linked as ada@composio.example.");
    expect(text()).not.toContain(COMPOSIO_IS);
    expect(container.querySelector("a")).toBeNull();
    expect(button("Unlink")).toBeTruthy();
    expect(text()).not.toContain("Link Composio");
  });

  it("unlinks after a confirm that says the connections made through it go, then reads the accounts again", async () => {
    await render();
    await press(button("Unlink"));
    expect(confirmDialog()?.textContent).toContain("Unlink Composio?");
    expect(confirmDialog()?.textContent).toContain(
      "The connections you made through Composio are deleted.",
    );
    expect(mocks.unlinkComposio).not.toHaveBeenCalled();

    mocks.getComposioStatus.mockResolvedValue(ON);
    await press(button("Unlink", confirmDialog()!));
    expect(mocks.unlinkComposio).toHaveBeenCalledOnce();
    expect(confirmDialog()).toBeNull();
    expect(mocks.toast.success).toHaveBeenCalledWith("Composio unlinked");
    expect(mocks.listMyConnections).toHaveBeenCalledTimes(2);
    expect(button("Link Composio")).toBeTruthy();
  });

  it("keeps the link when they cancel", async () => {
    await render();
    await press(button("Unlink"));
    await press(button("Cancel", confirmDialog()!));
    expect(mocks.unlinkComposio).not.toHaveBeenCalled();
    expect(text()).toContain("Linked as ada@composio.example.");
  });
});
