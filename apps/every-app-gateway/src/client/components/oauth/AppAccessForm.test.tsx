// @vitest-environment happy-dom
/**
 * The Allow page's form rendered for real: which app asks to use which
 * account, each by its icon, what the app says it does with the account,
 * the scopes it lists, and what it posts: the one-use state and the
 * decision, to the action the server named.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOW_APPROVE, ALLOW_FIELDS } from "@/schemas/app-access";
import type { AppAccessContext } from "@/server/oauth/appAccessConsent";
import { AppAccessForm } from "./AppAccessForm";
import { ALLOW_ARM_DELAY_MS } from "./useDeliberateAllow";

type OkContext = Extract<AppAccessContext, { ok: true }>;

const CONTEXT: OkContext = {
  ok: true,
  state: "state-1",
  action: "/connect/google-workspace/allow",
  email: "ada@acme.com",
  provider: { id: "google-workspace", name: "Google Workspace" },
  app: {
    id: "openseo",
    name: "OpenSEO",
    hostname: "openseo.acme.example.com",
    status: "active",
    icon: "/everyapp-icon.svg",
  },
  account: "ada@gmail.com",
  why: "Charts your Search Console clicks.",
  scopes: ["webmasters.readonly", "analytics.readonly"],
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let sent: { action: string | null; method: string | null; data: FormData }[];
let switchAccount: ReturnType<typeof vi.fn<() => void>>;

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

function render(context: OkContext = CONTEXT) {
  act(() =>
    root.render(
      <AppAccessForm context={context} onSwitchAccount={switchAccount} />,
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

function text(): string {
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function chips(): string[] {
  return [...container.querySelectorAll("li")].map(
    (chip) => chip.textContent ?? "",
  );
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
  sent = [];
  switchAccount = vi.fn<() => void>();
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
});

describe("what the Allow page says", () => {
  it("names the app, the provider and the connected account", () => {
    render();
    expect(container.querySelector("h1")?.textContent).toBe(
      "Allow OpenSEO to use your Google Workspace account?",
    );
    expect(text()).toContain("ada@acme.com");
    expect(text()).toContain("Google Workspace accountada@gmail.com");
    expect(button("Don't allow")).toBeTruthy();
  });

  it("leaves the account out when the provider didn't name one", () => {
    render({ ...CONTEXT, account: null });
    // Only the heading names the provider's account.
    expect(text().split("Google Workspace account")).toHaveLength(2);
    expect(text()).toContain("ada@acme.com");
  });

  it("shows the app's icon from the app's own host", () => {
    render();
    expect(container.querySelector("header img")?.getAttribute("src")).toBe(
      "//openseo.acme.example.com/everyapp-icon.svg",
    );
  });

  it("shows a preset provider's mark, and another provider's first letter", () => {
    render();
    const tile = () => container.querySelector("header div")!.lastElementChild!;
    expect(tile().querySelector("svg")).toBeTruthy();
    render({ ...CONTEXT, provider: { id: "acme-mail", name: "Acme Mail" } });
    expect(tile().querySelector("svg")).toBeNull();
    expect(tile().textContent).toBe("A");
  });

  it("says what the app does with the account, when the app says", () => {
    render();
    expect(text()).toContain("Charts your Search Console clicks.");
    render({ ...CONTEXT, why: null });
    expect(container.querySelector("header p")).toBeNull();
  });

  it("lists the scopes the app asks for under their name, one chip each", () => {
    render();
    expect(text()).toContain("Scopes");
    expect(chips()).toEqual(["webmasters.readonly", "analytics.readonly"]);
  });

  it("says nothing about scopes for an app that lists none", () => {
    render({ ...CONTEXT, scopes: [] });
    expect(text()).not.toContain("Scopes");
    expect(chips()).toEqual([]);
  });

  it("offers another account", () => {
    render();
    act(() => button("Switch account").click());
    expect(switchAccount).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(0);
  });
});

describe("what the Allow form posts", () => {
  it("is the state and the approval, to the action the server named", () => {
    render();
    armAllow();
    act(() => button("Allow").click());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("post");
    expect(sent[0]!.action).toBe("/connect/google-workspace/allow");
    expect([...sent[0]!.data.entries()]).toEqual([
      [ALLOW_FIELDS.state, "state-1"],
      [ALLOW_FIELDS.decision, ALLOW_APPROVE],
    ]);
  });

  it("posts the refusal with the same state", () => {
    render();
    act(() => button("Don't allow").click());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.action).toBe("/connect/google-workspace/allow");
    expect([...sent[0]!.data.entries()]).toEqual([
      [ALLOW_FIELDS.state, "state-1"],
      [ALLOW_FIELDS.decision, "deny"],
    ]);
  });

  it("can't be allowed until the page has been seen", () => {
    render();
    expect(button("Allow").disabled).toBe(true);
    armAllow();
    expect(button("Allow").disabled).toBe(false);
  });

  it("sends one answer, however often a button is pressed", () => {
    render();
    armAllow();
    act(() => button("Allow").click());
    act(() => button("Allow").click());
    expect(sent).toHaveLength(1);
  });
});
