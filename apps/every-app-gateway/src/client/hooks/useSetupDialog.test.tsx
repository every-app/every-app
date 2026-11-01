// @vitest-environment happy-dom
/**
 * The setup dialog's app, driven through React for real: opened by id and
 * read from the live list each render, so it closes by itself once the
 * list says the app is ready or gone, and the list is re-read while it is
 * open.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppSetup } from "@every-app/sdk/internal";
import type { UserAccessApp } from "@/types/app";
import { SETUP_REFETCH_MS, useSetupDialog } from "./useSetupDialog";

function app(overrides: Partial<UserAccessApp>): UserAccessApp {
  return {
    id: "row-inbox",
    organizationId: "org-acme",
    appId: "inbox",
    name: "OpenMail",
    description: "A shared inbox.",
    hostname: "inbox.apps.example.com",
    tier: "service_binding",
    status: "active",
    isDefault: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    grantedAt: new Date(0),
    via: null,
    icon: null,
    setup: null,
    paused: false,
    ...overrides,
  };
}

const UNREADY: AppSetup = {
  ready: false,
  settings: [],
  unmet: [],
  groups: [],
  command: { command: "pnpm everyapp secret set EMAIL_FROM EMAIL_FROM_NAME" },
};
const READY: AppSetup = {
  ready: true,
  settings: [],
  unmet: [],
  groups: [],
  command: null,
};

const INBOX = app({ setup: UNREADY });
const SEO = app({ id: "row-seo", appId: "seo", name: "OpenSEO" });

type Dialog = ReturnType<typeof useSetupDialog<UserAccessApp>>;
let latest: Dialog;
const refetch = vi.fn();

function Harness({ apps }: { apps: UserAccessApp[] }) {
  latest = useSetupDialog(apps, refetch);
  return null;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  refetch.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(apps: UserAccessApp[] = [INBOX, SEO]) {
  act(() => root.render(<Harness apps={apps} />));
}

it("opens the app whose id was given, as the list has it, and closes from the footer", () => {
  render();
  expect(latest.app).toBeNull();
  act(() => latest.open({ id: "row-inbox" }));
  expect(latest.app?.id).toBe("row-inbox");
  expect(latest.app?.setup.command?.command).toContain("EMAIL_FROM");
  act(() => latest.close());
  expect(latest.app).toBeNull();
});

it("shows the list's latest setup while open", () => {
  render();
  act(() => latest.open(INBOX));
  const later = {
    ...UNREADY,
    command: { command: "pnpm everyapp secret set EMAIL_FROM_NAME" },
  };
  render([app({ setup: later }), SEO]);
  expect(latest.app?.setup.command?.command).toBe(
    "pnpm everyapp secret set EMAIL_FROM_NAME",
  );
});

it("closes by itself once the list says the app no longer needs setup, and stays closed", () => {
  render();
  act(() => latest.open(INBOX));
  render([app({ setup: READY }), SEO]);
  expect(latest.app).toBeNull();
  // Needing setup again later is a new request, not a reopening.
  render([INBOX, SEO]);
  expect(latest.app).toBeNull();
  act(() => latest.open(INBOX));
  expect(latest.app?.id).toBe("row-inbox");
});

it("closes when the app leaves the list", () => {
  render();
  act(() => latest.open(INBOX));
  render([SEO]);
  expect(latest.app).toBeNull();
});

it("re-reads the list every 15 s while open, and stops once it closes", () => {
  vi.useFakeTimers();
  render();
  act(() => latest.open(INBOX));
  expect(refetch).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(SETUP_REFETCH_MS));
  expect(refetch).toHaveBeenCalledOnce();
  act(() => void vi.advanceTimersByTime(SETUP_REFETCH_MS));
  expect(refetch).toHaveBeenCalledTimes(2);
  act(() => latest.close());
  act(() => void vi.advanceTimersByTime(SETUP_REFETCH_MS * 3));
  expect(refetch).toHaveBeenCalledTimes(2);
  // Closing by itself stops it too.
  act(() => latest.open(INBOX));
  render([app({ setup: READY }), SEO]);
  act(() => void vi.advanceTimersByTime(SETUP_REFETCH_MS * 3));
  expect(refetch).toHaveBeenCalledTimes(2);
});
