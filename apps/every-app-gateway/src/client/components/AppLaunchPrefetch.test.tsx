// @vitest-environment happy-dom
/**
 * The speculation rules the signed-in layout mounts: one script in the
 * head naming the apps that open, replaced when that list changes and
 * removed with the component.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserAccessApp } from "@/types/app";
import { AppLaunchPrefetch } from "./AppLaunchPrefetch";

// The library hook's collections reach the server's Worker bindings; the
// component reads only `apps` from it.
const library = vi.hoisted(() => ({
  apps: [] as UserAccessApp[],
  organizationId: "org-acme" as string | null,
}));
vi.mock("@/client/hooks/useAppLibrary", () => ({
  useAppLibrary: () => ({ apps: library.apps }),
}));
vi.mock("@/client/hooks/useSession", () => ({
  useSession: () => ({
    data: library.organizationId
      ? { session: { activeOrganizationId: library.organizationId } }
      : null,
  }),
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
    paused: false,
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

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(apps: UserAccessApp[]) {
  library.apps = apps;
  act(() => root.render(<AppLaunchPrefetch site="apps.example.com" />));
}

const scripts = () =>
  document.head.querySelectorAll('script[type="speculationrules"]');
const urls = () => {
  const script = scripts()[0];
  if (!script) throw new Error("no speculation rules");
  return (
    JSON.parse(script.textContent ?? "") as { prefetch: { urls: string[] }[] }
  ).prefetch[0]?.urls;
};

it("mounts one speculation rules script naming the apps that open", () => {
  render([
    app(),
    app({ id: "row-crm", appId: "crm", hostname: "crm.apps.example.com" }),
    app({
      id: "row-setup",
      appId: "setup",
      hostname: "setup.apps.example.com",
      setup: UNREADY,
    }),
  ]);
  expect(scripts()).toHaveLength(1);
  expect(urls()).toEqual([
    "https://seo.apps.example.com/",
    "https://crm.apps.example.com/",
  ]);
  expect(container.innerHTML).toBe("");
});

it("replaces the script when the list of hosts changes, and removes it on unmount", () => {
  render([app()]);
  expect(urls()).toEqual(["https://seo.apps.example.com/"]);
  render([
    app(),
    app({ id: "row-crm", appId: "crm", hostname: "crm.apps.example.com" }),
  ]);
  expect(scripts()).toHaveLength(1);
  expect(urls()).toEqual([
    "https://seo.apps.example.com/",
    "https://crm.apps.example.com/",
  ]);
  act(() => root.unmount());
  expect(scripts()).toHaveLength(0);
});

it("mounts no script when nothing opens", () => {
  render([app({ setup: UNREADY })]);
  expect(scripts()).toHaveLength(0);
});

it("replaces the script when the person switches organization, so nothing prefetched as the old one is committed", () => {
  render([app()]);
  const before = scripts()[0];
  library.organizationId = "org-other";
  act(() => root.render(<AppLaunchPrefetch site="apps.example.com" />));
  const after = scripts();
  expect(after).toHaveLength(1);
  expect(after[0]).not.toBe(before);
  expect(before?.isConnected).toBe(false);
  library.organizationId = "org-acme";
});

it("lists no app on another site", () => {
  render([
    app({
      id: "row-third",
      appId: "third",
      hostname: "third-acme.apps-of-others.example",
    }),
  ]);
  expect(scripts()).toHaveLength(0);
});
