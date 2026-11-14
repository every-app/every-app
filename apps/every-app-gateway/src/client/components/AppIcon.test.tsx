// @vitest-environment happy-dom
/**
 * Where an app's icon is asked for, in order: the Gateway's own address,
 * then the app's host (its manifest icon, its favicon), then the first
 * letter. Each image that fails to load gives way to the next.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppIcon } from "./AppIcon";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CRM = {
  name: "open crm",
  hostname: "crm.apps.example.com",
  status: "active",
  icon: "/everyapp-icon.svg",
} as const;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(app: Parameters<typeof AppIcon>[0]["app"]) {
  act(() => root.render(<AppIcon app={app} />));
}

const src = () => container.querySelector("img")?.getAttribute("src") ?? null;

function fail() {
  act(() => {
    container.querySelector("img")!.dispatchEvent(new Event("error"));
  });
}

describe("AppIcon", () => {
  it("asks the Gateway first, then the app's own host, then shows the first letter", () => {
    render(CRM);
    expect(src()).toBe("/app-icon/crm.apps.example.com");
    fail();
    expect(src()).toBe("//crm.apps.example.com/everyapp-icon.svg");
    fail();
    expect(src()).toBe("//crm.apps.example.com/favicon.ico");
    fail();
    expect(src()).toBeNull();
    expect(container.textContent).toBe("O");
  });

  it("skips the manifest icon on the app's host when the manifest names none", () => {
    render({ ...CRM, icon: null });
    expect(src()).toBe("/app-icon/crm.apps.example.com");
    fail();
    expect(src()).toBe("//crm.apps.example.com/favicon.ico");
  });

  it("shows the letter, and asks for nothing, for an app that isn't live or has no host", () => {
    render({ ...CRM, status: "binding" });
    expect(src()).toBeNull();
    expect(container.textContent).toBe("O");

    render({ ...CRM, hostname: null });
    expect(src()).toBeNull();
  });
});
