// @vitest-environment happy-dom
/**
 * The native app's consent form rendered for real: which app it opens, as
 * whom and where the code goes (this computer for a loopback redirect), a
 * verified domain or the unverified mark, and what it posts: the app's
 * origin as `resource` and the organization, nothing to pick apps or access
 * with.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDecisionForm } from "@/schemas/consent-decision";
import {
  NativeConsentForm,
  type NativeConsentContext,
} from "./NativeConsentForm";
import { ALLOW_ARM_DELAY_MS } from "./useDeliberateAllow";

const OPENZEN = {
  rowId: "app-openzen",
  slug: "openzen",
  name: "OpenZen",
  hostname: "openzen.example.com",
};

const CONTEXT: NativeConsentContext = {
  ok: true,
  handle: "handle-1",
  client: {
    id: "client-1",
    name: "OpenZen for Mac",
    domain: null,
    redirectUri: "http://127.0.0.1:53682/callback",
    redirectHost: "127.0.0.1",
    redirectIsLoopback: true,
  },
  email: "member@example.com",
  grant: {
    kind: "native",
    resource: "https://openzen.example.com",
    app: OPENZEN,
  },
  organizations: [org("org-acme", "Acme")],
  defaultOrganizationId: "org-acme",
  writeRequested: true,
};

/** An organization where the member can open OpenZen, as lane a lists it. */
function org(id: string, name: string) {
  return {
    id,
    name,
    role: "member",
    apps: [{ ...OPENZEN, tools: "unknown" as const }],
  };
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
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
  submit.preventDefault();
}

function render(context: NativeConsentContext = CONTEXT) {
  act(() =>
    root.render(
      <NativeConsentForm context={context} onSwitchAccount={() => undefined} />,
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

describe("what the native consent page says", () => {
  it("names the app, its host and organization, and this computer", () => {
    render();
    expect(container.querySelector("h1")?.textContent).toBe(
      "OpenZen for Mac wants to use OpenZen",
    );
    expect(text()).toContain(
      "It wants to use OpenZen (openzen.example.com) as you, in Acme: everything you can do there.",
    );
    expect(text()).toContain("Back to the app on this computer (127.0.0.1)");
    expect(text()).toContain("Signed in as");
    expect(text()).toContain("member@example.com");
    // Nothing to choose: one app, everything the member can do there.
    expect(container.querySelector('input[name="app_mode"]')).toBeNull();
    expect(container.querySelector('input[name="app_ids"]')).toBeNull();
    expect(container.querySelector('input[name="access"]')).toBeNull();
    expect(button("Don't allow")).toBeTruthy();
  });

  it("marks a self-named client unverified", () => {
    render();
    expect(text()).toContain("Unverified");
    expect(text()).toContain("This app chose its own name.");
  });

  it("shows a metadata-document client's domain as verified", () => {
    render({
      ...CONTEXT,
      client: {
        ...CONTEXT.client,
        id: "https://openzen.app/oauth/client.json",
        domain: "openzen.app",
      },
    });
    expect(text()).toContain("Published by openzen.app");
    expect(text()).not.toContain("Unverified");
  });

  it("names an https redirect's host, and warns when the domain doesn't cover it", () => {
    render({
      ...CONTEXT,
      client: {
        ...CONTEXT.client,
        domain: "openzen.app",
        redirectUri: "https://elsewhere.example/callback",
        redirectHost: "elsewhere.example",
        redirectIsLoopback: false,
      },
    });
    expect(text()).toContain("Access will be sent to elsewhere.example");
    expect(text()).not.toContain("on this computer");
    expect(text()).toContain("a different site");
    expect(text()).not.toContain("Published by");
  });

  it("has nothing to allow without an organization that can open the app", () => {
    render({ ...CONTEXT, organizations: [], defaultOrganizationId: null });
    armAllow();
    expect(text()).toContain(
      "You can't open OpenZen in any of your organizations",
    );
    expect(button("Allow").disabled).toBe(true);
  });
});

describe("what the native consent form posts", () => {
  it("is the app's origin as resource and the organization", () => {
    render();
    armAllow();
    act(() => button("Allow").click());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("resource")).toBe("https://openzen.example.com");
    expect(parseDecisionForm(sent[0]!)).toMatchObject({
      handle: "handle-1",
      decision: "approve",
      client_id: "client-1",
      redirect_uri: "http://127.0.0.1:53682/callback",
      organization_id: "org-acme",
      resource: "https://openzen.example.com",
    });
    // Nothing here picks apps or access: the server fixes them.
    expect(sent[0]!.has("app_mode")).toBe(false);
    expect(sent[0]!.has("access")).toBe(false);
  });

  it("carries the organization picked for a shared app", () => {
    render({
      ...CONTEXT,
      organizations: [org("org-acme", "Acme"), org("org-beta", "Beta")],
    });
    armAllow();
    act(() =>
      container
        .querySelector<HTMLInputElement>(
          'input[name="organization_id"][value="org-beta"]',
        )!
        .click(),
    );
    expect(text()).toContain("as you, in Beta");
    act(() => button("Allow").click());
    expect(parseDecisionForm(sent[0]!)).toMatchObject({
      organization_id: "org-beta",
    });
  });

  it("can't be allowed until the page has been seen", () => {
    render();
    expect(button("Allow").disabled).toBe(true);
    act(() => button("Don't allow").click());
    expect(parseDecisionForm(sent[0]!)).toMatchObject({ decision: "deny" });
  });
});
