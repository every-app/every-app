// @vitest-environment happy-dom
/**
 * The consent form rendered for real (React in a DOM): what it posts, read
 * by the decision's own parser, and when its Allow button may be pressed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDecisionForm } from "@/schemas/consent-decision";
import type { ConsentContext } from "@/server/mcp-auth/consent";
import { ConsentForm } from "./ConsentForm";
import { ALLOW_ARM_DELAY_MS } from "./useDeliberateAllow";

type Context = Extract<ConsentContext, { ok: true }>;

const CONTEXT: Context = {
  ok: true,
  handle: "handle-1",
  client: {
    id: "client-1",
    name: "Codex",
    domain: null,
    redirectUri: "http://localhost:1455/auth/callback",
    redirectHost: "localhost",
  },
  email: "owner@example.com",
  writeRequested: true,
  organizations: [
    {
      id: "org-acme",
      name: "Acme",
      role: "owner",
      apps: [
        { rowId: "app-todo", slug: "todo", name: "Todos", tools: "ready" },
        { rowId: "app-notes", slug: "notes", name: "Notes", tools: "ready" },
        { rowId: "app-chef", slug: "chef", name: "Chef", tools: "none" },
        { rowId: "app-crm", slug: "crm", name: "CRM", tools: "unknown" },
      ],
    },
    { id: "org-other", name: "Other", role: "member", apps: [] },
  ],
  defaultOrganizationId: "org-acme",
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
/** What the browser would send: each submission the page let through. */
let sent: FormData[];

function recordSubmission(event: Event) {
  const submit = event as SubmitEvent;
  if (!submit.defaultPrevented) {
    sent.push(
      new FormData(
        submit.target as HTMLFormElement,
        submit.submitter as HTMLButtonElement | null,
      ),
    );
  }
  // Never navigate away from the test page.
  submit.preventDefault();
}

function render(context: Context = CONTEXT) {
  act(() =>
    root.render(
      <ConsentForm context={context} onSwitchAccount={() => undefined} />,
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

function input(name: string, value: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(
    `input[name="${name}"][value="${value}"]`,
  );
  if (!found) throw new Error(`no ${name}=${value}`);
  return found;
}

/** The hint beside an app's checkbox, or null without one. */
function hint(appRowId: string): string | null {
  const label = input("app_ids", appRowId).closest("label")!;
  const spans = [...label.querySelectorAll(":scope > span")];
  return spans.length > 2 ? (spans.at(-1)!.textContent ?? "") : null;
}

function fire(target: EventTarget, event: Event) {
  act(() => {
    target.dispatchEvent(event);
  });
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Press a button the way a browser does: no click reaches a disabled one. */
function press(element: HTMLButtonElement) {
  act(() => {
    element.click();
  });
}

/** Let Allow arm: the page has been seen for a moment, and the pointer moved. */
function armAllow() {
  wait(ALLOW_ARM_DELAY_MS);
  fire(window, new PointerEvent("pointermove", { pointerType: "mouse" }));
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  window.addEventListener("submit", recordSubmission);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.removeEventListener("submit", recordSubmission);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what the consent form posts", () => {
  it("is what the decision reads, with the defaults", () => {
    render();
    armAllow();
    press(button("Allow"));
    expect(sent).toHaveLength(1);
    expect(parseDecisionForm(sent[0]!)).toEqual({
      handle: "handle-1",
      decision: "approve",
      client_id: "client-1",
      redirect_uri: "http://localhost:1455/auth/callback",
      organization_id: "org-acme",
      app_mode: "all",
      app_ids: [],
      access: "read",
    });
  });

  it("offers no read & write when the client asked for mcp:read alone", () => {
    render({ ...CONTEXT, writeRequested: false });
    expect(
      container.querySelector('input[name="access"][value="write"]'),
    ).toBeNull();
    expect(input("access", "read").type).toBe("hidden");
    expect(container.textContent).toContain(
      "this app asked to read, not to add or change anything",
    );
    armAllow();
    press(button("Allow"));
    expect(parseDecisionForm(sent[0]!)).toMatchObject({ access: "read" });
  });

  it("carries the organization, chosen apps and access the user picked", () => {
    render();
    armAllow();
    act(() => input("app_mode", "selected").click());
    // Without a chosen app there is nothing to allow.
    expect(button("Allow").disabled).toBe(true);
    // An app without tools can't be chosen.
    expect(input("app_ids", "app-chef").disabled).toBe(true);
    expect(hint("app-chef")).toBe("(no AI tools yet)");
    // One whose tools aren't known yet can: they load on first use, and
    // the form says nothing about it.
    expect(input("app_ids", "app-crm").disabled).toBe(false);
    expect(hint("app-crm")).toBeNull();
    expect(hint("app-todo")).toBeNull();
    expect(hint("app-notes")).toBeNull();
    act(() => input("app_ids", "app-notes").click());
    act(() => input("access", "write").click());
    press(button("Allow"));
    expect(sent).toHaveLength(1);
    expect(parseDecisionForm(sent[0]!)).toMatchObject({
      decision: "approve",
      organization_id: "org-acme",
      app_mode: "selected",
      app_ids: ["app-notes"],
      access: "write",
    });
  });

  it("asks a member of one organization nothing about it, and posts it", () => {
    render({ ...CONTEXT, organizations: [CONTEXT.organizations[0]!] });
    expect(
      container.querySelector('input[type="radio"][name="organization_id"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Organization");
    armAllow();
    press(button("Allow"));
    expect(sent).toHaveLength(1);
    expect(parseDecisionForm(sent[0]!)).toMatchObject({
      decision: "approve",
      organization_id: "org-acme",
    });
  });

  it("allows a connection to only an app whose tools aren't known yet", () => {
    render();
    armAllow();
    act(() => input("app_mode", "selected").click());
    act(() => input("app_ids", "app-crm").click());
    expect(button("Allow").disabled).toBe(false);
    press(button("Allow"));
    expect(sent).toHaveLength(1);
    expect(parseDecisionForm(sent[0]!)).toMatchObject({
      app_mode: "selected",
      app_ids: ["app-crm"],
    });
  });

  it("sends one answer, however often it is pressed", () => {
    render();
    armAllow();
    const allow = button("Allow");
    press(allow);
    press(allow);
    press(button("Deny"));
    expect(sent).toHaveLength(1);
    expect(parseDecisionForm(sent[0]!)).toMatchObject({ decision: "approve" });
    // Shown as disabled, but not `disabled`, which would have dropped the
    // pressed button's decision from the form being sent.
    for (const label of ["Allow", "Deny"]) {
      expect(button(label).getAttribute("aria-disabled")).toBe("true");
      expect(button(label).classList.contains("opacity-50")).toBe(true);
    }
    expect(allow.disabled).toBe(false);
  });

  it("denies without waiting for Allow to arm", () => {
    render();
    press(button("Deny"));
    expect(sent).toHaveLength(1);
    expect(parseDecisionForm(sent[0]!)).toMatchObject({
      handle: "handle-1",
      decision: "deny",
    });
  });
});

describe("when Allow can be pressed", () => {
  const tap = (target: EventTarget) =>
    fire(
      target,
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
    );

  it("arms on a tap once the page has been seen for a moment", () => {
    render();
    const allow = button("Allow");
    expect(allow.disabled).toBe(true);
    wait(ALLOW_ARM_DELAY_MS);
    expect(allow.disabled).toBe(true);
    // A tap moves no pointer first: the tap that lands on Allow arms it.
    tap(allow);
    expect(allow.disabled).toBe(false);
    press(allow);
    expect(sent).toHaveLength(1);
  });

  it("arms on a touch from a browser without pointer events, or a pen", () => {
    render();
    wait(ALLOW_ARM_DELAY_MS);
    fire(button("Allow"), new TouchEvent("touchstart", { bubbles: true }));
    expect(button("Allow").disabled).toBe(false);

    act(() => root.unmount());
    root = createRoot(container);
    render();
    wait(ALLOW_ARM_DELAY_MS);
    fire(
      button("Allow"),
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "pen" }),
    );
    expect(button("Allow").disabled).toBe(false);
  });

  it("arms on a mouse move or a key press, never on a mouse press alone", () => {
    render();
    wait(ALLOW_ARM_DELAY_MS);
    const allow = button("Allow");
    fire(
      allow,
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
    );
    press(allow);
    expect(allow.disabled).toBe(true);
    expect(sent).toEqual([]);
    fire(window, new PointerEvent("pointermove", { pointerType: "mouse" }));
    expect(allow.disabled).toBe(false);

    act(() => root.unmount());
    root = createRoot(container);
    render();
    wait(ALLOW_ARM_DELAY_MS);
    fire(window, new KeyboardEvent("keydown", { key: "Tab" }));
    expect(button("Allow").disabled).toBe(false);
  });

  it("ignores a tap, click, move or key as the page appears", () => {
    render();
    const allow = button("Allow");
    // Double-click (or double-tap) jacking: the second press lands here as
    // the page appears.
    wait(ALLOW_ARM_DELAY_MS / 2);
    tap(allow);
    fire(window, new PointerEvent("pointermove", { pointerType: "mouse" }));
    fire(window, new KeyboardEvent("keydown", { key: "Enter" }));
    press(allow);
    expect(allow.disabled).toBe(true);
    expect(sent).toEqual([]);
    // Too early doesn't count later either.
    wait(ALLOW_ARM_DELAY_MS);
    expect(allow.disabled).toBe(true);
    tap(allow);
    expect(allow.disabled).toBe(false);
  });

  it("disarms when the page loses focus or is hidden, and waits again", () => {
    render();
    armAllow();
    const allow = button("Allow");
    expect(allow.disabled).toBe(false);

    fire(window, new FocusEvent("blur"));
    expect(allow.disabled).toBe(true);
    fire(window, new FocusEvent("focus"));
    tap(allow);
    expect(allow.disabled).toBe(true);
    wait(ALLOW_ARM_DELAY_MS);
    tap(allow);
    expect(allow.disabled).toBe(false);

    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    fire(document, new Event("visibilitychange"));
    expect(allow.disabled).toBe(true);
    visibility = "visible";
    fire(document, new Event("visibilitychange"));
    wait(ALLOW_ARM_DELAY_MS);
    tap(allow);
    expect(allow.disabled).toBe(false);
  });

  it("never arms in a window that doesn't have focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render();
    wait(ALLOW_ARM_DELAY_MS * 2);
    tap(button("Allow"));
    fire(window, new PointerEvent("pointermove", { pointerType: "mouse" }));
    expect(button("Allow").disabled).toBe(true);
  });
});

describe("who the page says the client is", () => {
  const cimd = (redirectUri: string): Context => {
    const url = new URL(redirectUri);
    return {
      ...CONTEXT,
      client: {
        id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
        name: "Claude",
        domain: "claude.ai",
        redirectUri,
        redirectHost: url.hostname,
      },
    };
  };
  const text = () => container.textContent?.replace(/\s+/g, " ") ?? "";

  it("verifies a published client that sends access to its own site", () => {
    render(cimd("https://claude.ai/api/mcp/auth_callback"));
    expect(text()).toContain("Published by claude.ai");
    expect(text()).not.toContain("a different site");
  });

  it("verifies one that sends access to an app on this computer, and names localhost", () => {
    render(cimd("http://localhost:51001/callback"));
    expect(text()).toContain("Published by claude.ai");
    expect(text()).toContain("Access will be sent to localhost.");
  });

  it("never verifies one that sends access to another site", () => {
    render(cimd("https://collector.example/callback"));
    expect(text()).not.toContain("Published by");
    expect(text()).toContain(
      "Its details are published on claude.ai, but it sends access to collector.example, a different site.",
    );
    expect(text()).toContain("Access will be sent to collector.example.");
  });

  it("calls a registered client unverified", () => {
    render();
    expect(text()).toContain("Unverified");
    expect(text()).toContain("Named by the app itself.");
    expect(text()).not.toContain("Published");
  });
});
