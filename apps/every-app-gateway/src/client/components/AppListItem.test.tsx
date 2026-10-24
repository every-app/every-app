// @vitest-environment happy-dom
/**
 * The home card rendered for real (React in a DOM): a ready app is a link,
 * an app that needs setup is a button that opens the setup dialog, and the
 * pin button works on either. The wording of the status is tested on
 * appStatus (lib/appStatus.test.ts).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppLibraryLayout } from "@/client/hooks/useAppLibrary";
import type { UserAccessApp } from "@/types/app";
import { AppListItem } from "./AppListItem";

// The card reads only the layout enum from the library hook, whose
// collections reach the server's Worker bindings; keep the test in the DOM.
vi.mock("@/client/hooks/useAppLibrary", () => ({
  AppLibraryLayout: { Grid: "grid", List: "list" },
}));

function app(overrides: Partial<UserAccessApp> = {}): UserAccessApp {
  return {
    id: "row-seo",
    organizationId: "org-acme",
    appId: "seo",
    name: "OpenSEO",
    description: "Keyword research.",
    hostname: "seo.apps.example.com",
    tier: "service_binding",
    status: "active",
    isDefault: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    grantedAt: new Date(0),
    via: null,
    icon: null,
    setup: null,
    ...overrides,
  };
}

const UNREADY: UserAccessApp["setup"] = {
  ready: false,
  settings: [],
  unmet: [],
  groups: [],
  command: { command: "pnpm everyapp secret set DATAFORSEO_API_KEY" },
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onOpenSetup: ReturnType<typeof vi.fn>;
let onTogglePin: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onOpenSetup = vi.fn();
  onTogglePin = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(item: UserAccessApp, layout = AppLibraryLayout.Grid) {
  act(() =>
    root.render(
      <AppListItem
        app={item}
        pinned={false}
        onTogglePin={onTogglePin}
        onOpenSetup={onOpenSetup}
        layout={layout}
      />,
    ),
  );
}

const text = () => container.textContent ?? "";
const setupButton = () =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="Set up OpenSEO"]',
  );
const openLink = () =>
  container.querySelector<HTMLAnchorElement>('a[aria-label="Open OpenSEO"]');

function press(element: HTMLElement | null) {
  if (!element) throw new Error("nothing to press");
  act(() => element.click());
}

it("opens the setup dialog from the card of an app that needs setup, in both layouts", () => {
  for (const layout of [AppLibraryLayout.Grid, AppLibraryLayout.List]) {
    render(app({ setup: UNREADY }), layout);
    expect(text()).toContain("Needs setup");
    expect(openLink()).toBeNull();
    expect(container.querySelector("a[href]")).toBeNull();
    expect(setupButton()?.getAttribute("aria-haspopup")).toBe("dialog");
    press(setupButton());
    expect(onOpenSetup).toHaveBeenCalledOnce();
    onOpenSetup.mockClear();
  }
});

it("keeps the pin button pinning, not opening the dialog", () => {
  render(app({ setup: UNREADY }));
  press(container.querySelector('button[aria-label="Pin OpenSEO"]'));
  expect(onTogglePin).toHaveBeenCalledOnce();
  expect(onOpenSetup).not.toHaveBeenCalled();
});

it("links to an app that is ready, with no setup button", () => {
  render(app());
  expect(openLink()?.getAttribute("href")).toBe("//seo.apps.example.com");
  expect(setupButton()).toBeNull();
  expect(text()).not.toContain("Needs setup");
});

it("neither links to an app that isn't deployed nor opens the dialog for it", () => {
  render(app({ hostname: null, setup: UNREADY }));
  expect(text()).toContain("Needs deploy");
  expect(openLink()).toBeNull();
  expect(setupButton()).toBeNull();
});
