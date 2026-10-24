// @vitest-environment happy-dom
/**
 * The launcher's `?setup=<appId>`, driven through React for real: it opens
 * the setup dialog once for an app that still needs setup, strips the
 * param either way, waits for the list, and takes the same id again once
 * the param has gone.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserAccessApp } from "@/types/app";
import { useMcpParam, useSetupParam } from "./useSetupParam";

type Props = Parameters<typeof useSetupParam>[0];

function app(overrides: Partial<UserAccessApp>): UserAccessApp {
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

const SEO = app({
  setup: {
    ready: false,
    settings: [],
    unmet: [],
    groups: [],
    command: { command: "pnpm everyapp configure openseo" },
  },
});
const TODO = app({ id: "row-todo", appId: "todo", name: "Todos" });

function Harness(props: Props) {
  useSetupParam(props);
  return null;
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let open: ReturnType<typeof vi.fn<Props["open"]>>;
let strip: ReturnType<typeof vi.fn<Props["strip"]>>;

beforeEach(() => {
  open = vi.fn();
  strip = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Render the launcher's state, by default with the list in and `?setup=seo`. */
function render(props: Partial<Props> = {}) {
  act(() =>
    root.render(
      <Harness
        setupParam="seo"
        apps={[SEO, TODO]}
        loaded
        open={open}
        strip={strip}
        {...props}
      />,
    ),
  );
}

it("opens the dialog once for an app that still needs setup, and strips the param", () => {
  render();
  expect(open).toHaveBeenCalledExactlyOnceWith(SEO);
  expect(strip).toHaveBeenCalledOnce();
  // The list re-renders (a new array, a new strip closure) before the
  // navigation lands: still once.
  render({ apps: [SEO, TODO], strip: vi.fn(() => strip()) });
  expect(open).toHaveBeenCalledOnce();
  expect(strip).toHaveBeenCalledOnce();
});

it("waits for the list", () => {
  render({ loaded: false });
  expect(open).not.toHaveBeenCalled();
  expect(strip).not.toHaveBeenCalled();
  render({ loaded: true });
  expect(open).toHaveBeenCalledExactlyOnceWith(SEO);
  expect(strip).toHaveBeenCalledOnce();
});

it("only strips the param for an app that is ready, or isn't in the list", () => {
  for (const setupParam of ["todo", "ghost"]) {
    render({ setupParam });
    expect(open).not.toHaveBeenCalled();
    expect(strip).toHaveBeenCalledOnce();
    act(() => root.unmount());
    root = createRoot(container);
    strip.mockClear();
  }
});

it("takes the same id again once the param has gone, and does nothing without one", () => {
  render({ setupParam: undefined });
  expect(open).not.toHaveBeenCalled();
  expect(strip).not.toHaveBeenCalled();
  render();
  render({ setupParam: undefined });
  expect(open).toHaveBeenCalledOnce();
  expect(strip).toHaveBeenCalledOnce();
  // The perimeter sent the person back: a new request.
  render();
  expect(open).toHaveBeenCalledTimes(2);
  expect(strip).toHaveBeenCalledTimes(2);
});

/** `?mcp=<appId>` for the DataForSEO MCP app: the same hook, another dialog. */
const DATAFORSEO = app({
  id: "row-dataforseo",
  appId: "dataforseo",
  name: "DataForSEO",
  hostname: null,
  tier: "provider",
  setup: { ready: true, settings: [], unmet: [], groups: [], command: null },
});

function McpHarness(props: Parameters<typeof useMcpParam>[0]) {
  useMcpParam(props);
  return null;
}

it("opens an MCP app's dialog from ?mcp=, once, and only for an MCP app that is set up", () => {
  const renderMcp = (mcpParam: string | undefined, apps = [SEO, DATAFORSEO]) =>
    act(() =>
      root.render(
        <McpHarness
          mcpParam={mcpParam}
          apps={apps}
          loaded
          open={open}
          strip={strip}
        />,
      ),
    );
  renderMcp("dataforseo");
  expect(open).toHaveBeenCalledExactlyOnceWith(DATAFORSEO);
  expect(strip).toHaveBeenCalledOnce();
  renderMcp(undefined);
  // An app with a page, or an MCP app whose key is unset, only loses the param.
  renderMcp("seo");
  expect(open).toHaveBeenCalledOnce();
  expect(strip).toHaveBeenCalledTimes(2);
  renderMcp(undefined);
  renderMcp("dataforseo", [SEO, { ...DATAFORSEO, setup: SEO.setup }]);
  expect(open).toHaveBeenCalledOnce();
  expect(strip).toHaveBeenCalledTimes(3);
});
