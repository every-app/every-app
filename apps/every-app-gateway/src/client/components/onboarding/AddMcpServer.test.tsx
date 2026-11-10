// @vitest-environment happy-dom
/**
 * "Add an MCP server", rendered for real (React in a DOM): the form
 * offers every credential kind, sends the server function the shape it
 * reads, asks for a client when the server can't register one, shows a
 * refusal in the rule's own words, and once added says what to do next.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedRemoteMcpApp } from "@/types/mcpApp";

const mocks = vi.hoisted(() => ({
  addRemoteMcpApp: vi.fn(),
  listProviders: vi.fn(async () => ({
    providers: [
      { id: "elevenlabs", name: "ElevenLabs", kind: "api_key" },
      { id: "openai", name: "OpenAI", kind: "ai" },
      {
        id: "linear",
        name: "Linear",
        kind: "oauth",
        oauth: { flow: "gateway" },
      },
    ],
  })),
}));
vi.mock("@/serverFunctions/mcpApps", () => ({
  addRemoteMcpApp: mocks.addRemoteMcpApp,
}));
vi.mock("@/serverFunctions/providers", () => ({
  listProviders: mocks.listProviders,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { AddMcpServerDialog } from "./AddMcpServer";

const COPY = MCP_APP_COPY.addForm;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let onAdded: ReturnType<typeof vi.fn>;

function added(overrides: Partial<AddedRemoteMcpApp> = {}): AddedRemoteMcpApp {
  return {
    rowId: "11111111-1111-4111-8111-111111111111",
    appId: "treg",
    name: "treg",
    kind: "new",
    authKind: "none",
    credentialKind: "none",
    provider: null,
    secret: null,
    setupCommand: null,
    connectPath: null,
    oauth: null,
    toolCount: 12,
    toolsStatus: "ok",
    ...overrides,
  };
}

beforeEach(async () => {
  mocks.addRemoteMcpApp.mockReset();
  onAdded = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AddMcpServerDialog onClose={vi.fn()} onAdded={onAdded} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = () => dialog().textContent ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** The control a label names. */
function field(label: string): HTMLElement {
  const found = [...dialog().querySelectorAll("label")].find(
    (element) => element.textContent?.trim() === label,
  );
  const id = found?.getAttribute("for");
  const control = id ? document.getElementById(id) : null;
  if (!control) throw new Error(`no ${label} field`);
  return control;
}

async function type(label: string, value: string) {
  const input = field(label) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(label: string, option: string) {
  await act(async () => field(label).click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  const item = [...document.querySelectorAll('[role="option"]')].find(
    (element) => element.textContent?.trim() === option,
  ) as HTMLElement | undefined;
  if (!item) throw new Error(`no ${option} option`);
  await act(async () => item.click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("the Add an MCP server form", () => {
  it("asks for the URL, a name read from it, the credential and the risk default", async () => {
    expect(text()).toContain(COPY.title);
    for (const label of [
      COPY.urlLabel,
      COPY.nameLabel,
      COPY.credentialLabel,
      COPY.riskLabel,
    ]) {
      expect(field(label)).toBeTruthy();
    }
    // Nothing more to fill in until a kind takes it.
    expect(text()).not.toContain(COPY.headerLabel);
    await type(COPY.urlLabel, "https://mcp.deepwiki.com/mcp");
    expect(field(COPY.nameLabel).getAttribute("placeholder")).toBe("deepwiki");
    expect(text()).toContain(COPY.nameHelp("deepwiki"));
    expect(text()).toContain(COPY.riskItems[0]!.help);
  });

  it("names the Gateway setting a static credential's value goes in, from the app's id", async () => {
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await choose(COPY.credentialLabel, "Bearer token");
    expect(text()).toContain(COPY.tokenSettingHelp("TREG_MCP_TOKEN"));
    await type(COPY.nameLabel, "my-docs");
    expect(text()).toContain(COPY.tokenSettingHelp("MY_DOCS_MCP_TOKEN"));
  });

  it("refuses an empty URL and a name the rule refuses before sending anything", async () => {
    await press(button(COPY.submit));
    expect(text()).toContain(COPY.errors.url);
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await type(COPY.nameLabel, "Treg Notes");
    expect(text()).toContain(
      "The id must be kebab-case: lowercase letters, digits and hyphens, starting with a letter.",
    );
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).not.toHaveBeenCalled();
  });

  it("sends the URL, the name as the app's id, the auth block and the risk default", async () => {
    mocks.addRemoteMcpApp.mockResolvedValue(
      added({
        appId: "docs",
        name: "docs",
        authKind: "provider",
        credentialKind: "header",
        provider: "docs-mcp",
        secret: "DOCS_MCP_TOKEN",
        setupCommand: "pnpm everyapp secret set DOCS_MCP_TOKEN",
        toolCount: null,
        toolsStatus: null,
      }),
    );
    await type(COPY.urlLabel, "  https://docs.example.org/mcp ");
    await type(COPY.nameLabel, "docs");
    await choose(COPY.credentialLabel, "Header");
    await type(COPY.headerLabel, "X-Api-Key");
    await choose(COPY.riskLabel, "Everything read");
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).toHaveBeenCalledWith({
      data: {
        url: "https://docs.example.org/mcp",
        id: "docs",
        auth: { kind: "header", header: "X-Api-Key" },
        risk: "read",
      },
    });
    expect(onAdded).toHaveBeenCalledOnce();
  });

  it("shows the credential's command once a credentialed server is added", async () => {
    mocks.addRemoteMcpApp.mockResolvedValue(
      added({
        name: "Treg",
        authKind: "provider",
        credentialKind: "bearer",
        provider: "treg-mcp",
        secret: "TREG_MCP_TOKEN",
        setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
        toolCount: null,
        toolsStatus: null,
      }),
    );
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await choose(COPY.credentialLabel, "Bearer token");
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).toHaveBeenCalledWith({
      data: {
        url: "https://treg.to/mcp/",
        auth: { kind: "bearer" },
        risk: "annotations",
      },
    });
    expect(text()).toContain(MCP_APP_COPY.added.credentialTitle("Treg"));
    expect(dialog().querySelector("code")?.textContent).toBe(
      "pnpm everyapp secret set TREG_MCP_TOKEN",
    );
    expect(
      dialog().querySelector('[aria-label="Copy to clipboard"]'),
    ).not.toBeNull();
    expect(text()).toContain(MCP_APP_COPY.added.operatorNote);
  });

  it("says how many tools are on /mcp once a server with no credential is added, or that the Gateway lists them on first use", async () => {
    mocks.addRemoteMcpApp.mockResolvedValueOnce(added());
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await press(button(COPY.submit));
    expect(text()).toContain(MCP_APP_COPY.added.title("treg"));
    expect(text()).toContain(
      "Added. 12 tools are on this Gateway's /mcp as treg_<tool>.",
    );
  });

  it("says the Gateway lists the tools on first use when the listing didn't finish", async () => {
    mocks.addRemoteMcpApp.mockResolvedValueOnce(
      added({ toolCount: null, toolsStatus: null }),
    );
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await press(button(COPY.submit));
    expect(text()).toContain(MCP_APP_COPY.added.firstUse);
  });

  it("shows the rule's refusal under the form, as a sentence", async () => {
    mocks.addRemoteMcpApp.mockRejectedValueOnce(
      Object.assign(new Error("the URL must be https://"), {
        name: "PublicError",
        code: "REMOTE_MCP_URL_REFUSED",
      }),
    );
    await type(COPY.urlLabel, "http://treg.to/mcp/");
    await press(button(COPY.submit));
    const alert = dialog().querySelector('[role="alert"], [data-slot="alert"]');
    expect(alert?.textContent).toContain("The URL must be https://.");
    // Still the form, to fix and try again.
    expect(field(COPY.urlLabel)).toBeTruthy();
  });

  it("sends a query parameter's name", async () => {
    mocks.addRemoteMcpApp.mockResolvedValue(added());
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await choose(COPY.credentialLabel, "Query parameter");
    await press(button(COPY.submit));
    expect(text()).toContain(COPY.errors.param);
    expect(mocks.addRemoteMcpApp).not.toHaveBeenCalled();
    await type(COPY.paramLabel, "api_key");
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).toHaveBeenCalledWith({
      data: {
        url: "https://treg.to/mcp/",
        auth: { kind: "query", param: "api_key" },
        risk: "annotations",
      },
    });
  });

  it("offers the registry's API-key and OAuth providers", async () => {
    mocks.addRemoteMcpApp.mockResolvedValue(added());
    await type(COPY.urlLabel, "https://mcp.linear.app/mcp");
    await choose(COPY.credentialLabel, "Use a provider");
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => field(COPY.providerLabel).click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (element) => element.textContent?.trim(),
    );
    // The API-key and OAuth providers, never an AI one.
    expect(options).toContain("ElevenLabs (elevenlabs)");
    expect(options).toContain("Linear (linear)");
    expect(options.some((option) => option?.includes("openai"))).toBe(false);
    const item = [...document.querySelectorAll('[role="option"]')].find(
      (element) => element.textContent?.trim() === "Linear (linear)",
    ) as HTMLElement;
    await act(async () => item.click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).toHaveBeenCalledWith({
      data: {
        url: "https://mcp.linear.app/mcp",
        auth: { kind: "provider", provider: "linear" },
        risk: "annotations",
      },
    });
  });

  it("asks for a client and shows the redirect URI when the server can't register one, then sends it", async () => {
    mocks.addRemoteMcpApp.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "https://auth.treg.to doesn't offer dynamic client registration",
        ),
        { name: "PublicError", code: "REMOTE_MCP_OAUTH_NO_CLIENT" },
      ),
    );
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await choose(COPY.credentialLabel, "OAuth (sign in)");
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).toHaveBeenLastCalledWith({
      data: {
        url: "https://treg.to/mcp/",
        auth: { kind: "oauth" },
        risk: "annotations",
      },
    });
    expect(text()).toContain(COPY.clientIntro);
    expect(text()).toContain(
      `${window.location.origin}/connect/treg-mcp/callback`,
    );
    mocks.addRemoteMcpApp.mockResolvedValueOnce(
      added({
        authKind: "provider",
        credentialKind: "oauth",
        provider: "treg-mcp",
        connectPath:
          "/connect/treg-mcp?app=treg&return=%2Fconnections%2Faccounts",
        oauth: { issuer: "https://auth.treg.to", registered: "pasted" },
        toolCount: null,
        toolsStatus: null,
      }),
    );
    await type(COPY.clientIdLabel, "client-123");
    await type(COPY.clientSecretLabel, "shh");
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).toHaveBeenLastCalledWith({
      data: {
        url: "https://treg.to/mcp/",
        auth: { kind: "oauth", clientId: "client-123", clientSecret: "shh" },
        risk: "annotations",
      },
    });
    expect(text()).toContain(MCP_APP_COPY.added.connectTitle("treg"));
    const link = [...dialog().querySelectorAll("a")].find(
      (element) => element.textContent?.trim() === MCP_APP_COPY.added.connect,
    );
    expect(link?.getAttribute("href")).toBe(
      "/connect/treg-mcp?app=treg&return=%2Fconnections%2Faccounts",
    );
  });
});
