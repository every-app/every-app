// @vitest-environment happy-dom
/**
 * The Composio page's form rendered for real, by what the person has to do
 * next: sign in to Composio, which opens its page at the click, waits for
 * the approval and loads the page again; connect a service the app needs
 * in Composio, then check again; or allow, which posts the one-use state,
 * the decision and one account per service to the action the server
 * named.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { COMPOSIO_IS } from "@every-app/sdk/internal";
import { ALLOW_APPROVE } from "@/schemas/app-access";
import {
  COMPOSIO_FIELDS,
  ComposioLinkState,
  ComposioPageStep,
} from "@/schemas/composio";
import type { ComposioPageContext } from "@/server/composio/connect";

const mocks = vi.hoisted(() => ({
  startComposioLink: vi.fn(),
  finishComposioLink: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/serverFunctions/composio", () => ({
  startComposioLink: mocks.startComposioLink,
  finishComposioLink: mocks.finishComposioLink,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { COMPOSIO_CHECK_MS } from "@/client/hooks/useComposioLink";
import { ComposioForm } from "./ComposioForm";
import { ALLOW_ARM_DELAY_MS } from "./useDeliberateAllow";

type OkContext = Extract<ComposioPageContext, { ok: true }>;

const BASE = {
  ok: true as const,
  state: "state-1",
  action: "/connect/google-workspace/composio",
  email: "ada@acme.com",
  provider: { id: "google-workspace", name: "Google Workspace" },
  app: {
    id: "openmail",
    name: "OpenMail",
    hostname: "openmail.acme.example.com",
    status: "active",
    icon: "/everyapp-icon.svg",
  },
  why: "Reads and sends your mail.",
};

const LINK: OkContext = { ...BASE, step: ComposioPageStep.Link };

const MISSING: OkContext = {
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

const ALLOW: OkContext = {
  ...BASE,
  step: ComposioPageStep.Allow,
  services: [
    {
      slug: "gmail",
      label: "Gmail",
      accounts: [{ id: "ca_gmail", account: "ada@gmail.com" }],
      chosen: "ca_gmail",
    },
    {
      slug: "googlecalendar",
      label: "Calendar",
      accounts: [
        { id: "ca_cal_home", account: "ada@gmail.com" },
        { id: "ca_cal_work", account: "ada@work.com" },
      ],
      chosen: "ca_cal_work",
    },
  ],
};

const SIGN_IN = "https://dashboard.composio.dev/cli/sign-in/abc";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let sent: { action: string | null; method: string | null; data: FormData }[];
let reload: ReturnType<typeof vi.fn<() => Promise<void>>>;
let tab: {
  opener: unknown;
  location: { replace: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
};
let open: MockInstance<typeof window.open>;

function recordSubmission(event: Event) {
  const submit = event as SubmitEvent;
  if (!submit.defaultPrevented) {
    const form = submit.target as HTMLFormElement;
    sent.push({
      action: form.getAttribute("action"),
      method: form.getAttribute("method"),
      data: new FormData(form, submit.submitter as HTMLButtonElement | null),
    });
  }
  submit.preventDefault();
}

function render(context: OkContext) {
  act(() =>
    root.render(
      <ComposioForm
        context={context}
        onSwitchAccount={() => undefined}
        onReload={reload}
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

function link(label: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll("a")].find(
    (element) => element.textContent?.trim() === label,
  );
}

function text(): string {
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

const title = () => container.querySelector("h1")?.textContent;

/** Let what a click started settle, without moving the clock. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Wait until the page asks about the sign-in again. */
async function nextCheck() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(COMPOSIO_CHECK_MS);
  });
}

function armAllow() {
  act(() => {
    vi.advanceTimersByTime(ALLOW_ARM_DELAY_MS);
  });
  act(() => {
    window.dispatchEvent(
      new PointerEvent("pointermove", { pointerType: "mouse" }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of [
    mocks.startComposioLink,
    mocks.finishComposioLink,
    mocks.toast.error,
  ]) {
    fn.mockReset();
  }
  mocks.startComposioLink.mockResolvedValue({
    url: SIGN_IN,
    expiresAt: Date.now() + 600_000,
  });
  sent = [];
  reload = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  tab = { opener: window, location: { replace: vi.fn() }, close: vi.fn() };
  open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  window.addEventListener("submit", recordSubmission);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.removeEventListener("submit", recordSubmission);
  open.mockRestore();
  vi.useRealTimers();
});

describe("someone who hasn't linked their Composio", () => {
  it("is told what Composio is, and offered the sign-in", () => {
    render(LINK);
    expect(title()).toBe(
      "Sign in to Composio to use your Google Workspace account in OpenMail",
    );
    expect(text()).toContain(COMPOSIO_IS);
    expect(text()).toContain("ada@acme.com");
    expect(button("Sign in to Composio")).toBeTruthy();
    expect(container.querySelector("form")).toBeNull();
    expect(mocks.startComposioLink).not.toHaveBeenCalled();
  });

  it("opens Composio's page at the click, keeps a link to it, and waits", async () => {
    mocks.finishComposioLink.mockResolvedValue({
      state: ComposioLinkState.Waiting,
    });
    render(LINK);
    act(() => button("Sign in to Composio").click());
    // The tab is opened by the click itself, before the sign-in is known.
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    await flush();
    expect(mocks.startComposioLink).toHaveBeenCalledOnce();
    expect(tab.location.replace).toHaveBeenCalledWith(SIGN_IN);
    expect(text()).toContain("Approve the sign-in at Composio.");
    const shown = link("Open Composio")!;
    expect(shown.getAttribute("href")).toBe(SIGN_IN);
    expect(shown.target).toBe("_blank");
    expect(shown.rel).toBe("noopener noreferrer");

    // Asked every two seconds while it waits.
    expect(mocks.finishComposioLink).not.toHaveBeenCalled();
    await nextCheck();
    expect(mocks.finishComposioLink).toHaveBeenCalledTimes(1);
    await nextCheck();
    expect(mocks.finishComposioLink).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("loads the page again once the sign-in is approved, and stops asking", async () => {
    mocks.finishComposioLink
      .mockResolvedValueOnce({ state: ComposioLinkState.Waiting })
      .mockResolvedValue({ state: ComposioLinkState.Linked });
    render(LINK);
    act(() => button("Sign in to Composio").click());
    await flush();
    await nextCheck();
    expect(reload).not.toHaveBeenCalled();
    await nextCheck();
    expect(reload).toHaveBeenCalledOnce();
    await nextCheck();
    expect(mocks.finishComposioLink).toHaveBeenCalledTimes(2);
  });

  it("says the sign-in expired, and offers another", async () => {
    mocks.finishComposioLink.mockResolvedValue({
      state: ComposioLinkState.Expired,
    });
    render(LINK);
    act(() => button("Sign in to Composio").click());
    await flush();
    await nextCheck();
    expect(text()).toContain("The sign-in expired.");
    expect(link("Open Composio")).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    act(() => button("Sign in to Composio").click());
    await flush();
    expect(mocks.startComposioLink).toHaveBeenCalledTimes(2);
    expect(link("Open Composio")).toBeDefined();
  });

  it("closes the tab and says why when the sign-in can't start", async () => {
    mocks.startComposioLink.mockRejectedValue(
      Object.assign(new Error("COMPOSIO_UNAVAILABLE"), {
        code: "COMPOSIO_UNAVAILABLE",
      }),
    );
    render(LINK);
    act(() => button("Sign in to Composio").click());
    await flush();
    expect(tab.close).toHaveBeenCalledOnce();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Composio could not be reached. Try again.",
    );
    expect(button("Sign in to Composio")).toBeTruthy();
  });

  it("still waits in a browser that opened no tab", async () => {
    open.mockReturnValue(null);
    mocks.finishComposioLink.mockResolvedValue({
      state: ComposioLinkState.Waiting,
    });
    render(LINK);
    act(() => button("Sign in to Composio").click());
    await flush();
    expect(link("Open Composio")?.getAttribute("href")).toBe(SIGN_IN);
  });
});

describe("a service the app needs that isn't connected in their Composio", () => {
  it("names the service, links its page at Composio, and checks again", async () => {
    render(MISSING);
    expect(title()).toBe("Gmail isn't connected in your Composio");
    expect(text()).toContain("OpenMail needs it.");
    const connect = link("Connect Gmail in Composio")!;
    expect(connect.getAttribute("href")).toBe(
      "https://dashboard.composio.dev/~/~/connect/apps/gmail",
    );
    expect(connect.target).toBe("_blank");
    expect(container.querySelector("form")).toBeNull();

    let loaded!: () => void;
    reload.mockReturnValue(
      new Promise<void>((resolve) => {
        loaded = resolve;
      }),
    );
    act(() => button("Check again").click());
    expect(reload).toHaveBeenCalledOnce();
    expect(button("Check again").disabled).toBe(true);
    await act(async () => loaded());
    expect(button("Check again").disabled).toBe(false);
  });

  it("names each one when there are several", () => {
    render({
      ...MISSING,
      missing: [
        ...MISSING.missing,
        {
          slug: "googlecalendar",
          label: "Calendar",
          url: "https://dashboard.composio.dev/~/~/connect/apps/googlecalendar",
        },
      ],
    } as OkContext);
    expect(title()).toBe(
      "Gmail and Calendar aren't connected in your Composio",
    );
    expect(text()).toContain("OpenMail needs them.");
    expect(link("Connect Gmail in Composio")).toBeDefined();
    expect(link("Connect Calendar in Composio")?.getAttribute("href")).toBe(
      "https://dashboard.composio.dev/~/~/connect/apps/googlecalendar",
    );
  });
});

describe("every service the app needs is in their Composio", () => {
  it("asks, with each service's account and a choice where there are several", () => {
    render(ALLOW);
    expect(title()).toBe(
      "Allow OpenMail to use your Google Workspace account from Composio?",
    );
    expect(text()).toContain("Reads and sends your mail.");
    expect(text()).toContain("Gmailada@gmail.com");
    expect(text()).toContain(
      "OpenMail can do whatever these accounts allow in Composio.",
    );
    // One account is stated; several are a choice, the chosen one selected.
    const selects = [...container.querySelectorAll("select")];
    expect(selects.map((select) => select.name)).toEqual([
      COMPOSIO_FIELDS.account("googlecalendar"),
    ]);
    expect(
      [...selects[0]!.options].map((option) => [
        option.value,
        option.textContent,
      ]),
    ).toEqual([
      ["ca_cal_home", "ada@gmail.com"],
      ["ca_cal_work", "ada@work.com"],
    ]);
    expect(selects[0]!.value).toBe("ca_cal_work");
    expect(
      container.querySelector<HTMLLabelElement>("label")?.textContent,
    ).toBe("Calendar");
    expect(button("Don't allow")).toBeTruthy();
  });

  it("posts the state, the approval and one account per service, to the action the server named", () => {
    render(ALLOW);
    armAllow();
    act(() => button("Allow").click());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("post");
    expect(sent[0]!.action).toBe("/connect/google-workspace/composio");
    expect(Object.fromEntries(sent[0]!.data.entries())).toEqual({
      [COMPOSIO_FIELDS.state]: "state-1",
      [COMPOSIO_FIELDS.decision]: ALLOW_APPROVE,
      [COMPOSIO_FIELDS.account("gmail")]: "ca_gmail",
      [COMPOSIO_FIELDS.account("googlecalendar")]: "ca_cal_work",
    });
    expect([...sent[0]!.data.keys()]).toHaveLength(4);
  });

  it("posts the account the person picked instead", () => {
    render(ALLOW);
    const select = container.querySelector("select")!;
    act(() => {
      select.value = "ca_cal_home";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    armAllow();
    act(() => button("Allow").click());
    expect(sent[0]!.data.get(COMPOSIO_FIELDS.account("googlecalendar"))).toBe(
      "ca_cal_home",
    );
    expect(sent[0]!.data.get(COMPOSIO_FIELDS.account("gmail"))).toBe(
      "ca_gmail",
    );
  });

  it("posts the refusal with the same state", () => {
    render(ALLOW);
    act(() => button("Don't allow").click());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.action).toBe("/connect/google-workspace/composio");
    expect(sent[0]!.data.get(COMPOSIO_FIELDS.state)).toBe("state-1");
    expect(sent[0]!.data.get(COMPOSIO_FIELDS.decision)).toBe("deny");
  });

  it("can't be allowed until the page has been seen, and sends one answer", () => {
    render(ALLOW);
    expect(button("Allow").disabled).toBe(true);
    armAllow();
    expect(button("Allow").disabled).toBe(false);
    act(() => button("Allow").click());
    act(() => button("Allow").click());
    expect(sent).toHaveLength(1);
  });

  it("says it of one account", () => {
    render({
      ...ALLOW,
      services: [ALLOW.services[0]!],
    } as OkContext);
    expect(text()).toContain(
      "OpenMail can do whatever this account allows in Composio.",
    );
    expect(container.querySelector("select")).toBeNull();
  });
});
