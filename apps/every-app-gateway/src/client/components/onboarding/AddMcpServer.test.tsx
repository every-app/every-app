// @vitest-environment happy-dom
/**
 * "Add an MCP server" in the Add app chooser, rendered for real (React in
 * a DOM): the row sits between the four apps and Build your own, the form
 * checks the credential's name as typed with the shared rule, sends the
 * server function the shape it reads, shows a refusal in the rule's own
 * words, and once added says what to do next.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedRemoteMcpApp } from "@/types/mcpApp";

const mocks = vi.hoisted(() => ({
  addRemoteMcpApp: vi.fn(),
}));
vi.mock("@/serverFunctions/mcpApps", () => ({
  addRemoteMcpApp: mocks.addRemoteMcpApp,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FEATURED_APPS } from "@/client/lib/featuredApps";
import { FIRST_SCREEN } from "@/client/lib/firstScreen";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { AddAppDialog } from "./AddAppDialog";

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
    secret: null,
    setupCommand: null,
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
    root.render(
      <AddAppDialog canRun onClose={vi.fn()} onMcpAppAdded={onAdded} />,
    );
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

async function openForm() {
  await press(
    button(MCP_APP_COPY.chooserRow.title + MCP_APP_COPY.chooserRow.line),
  );
}

describe("the Add app chooser", () => {
  it("lists Add an MCP server between the four apps and Build your own", () => {
    const rows = [...dialog().querySelectorAll("li button")].map(
      (row) => row.querySelector("span span")?.textContent,
    );
    expect(rows).toEqual([
      ...FEATURED_APPS.map((app) => app.name),
      MCP_APP_COPY.chooserRow.title,
      FIRST_SCREEN.buildCard.title,
    ]);
    expect(text()).toContain(MCP_APP_COPY.chooserRow.line);
  });
});

describe("the Add an MCP server form", () => {
  it("asks for the URL, a name read from it, the credential and the risk default, and goes back to the list", async () => {
    await openForm();
    expect(text()).toContain(COPY.title);
    for (const label of [
      COPY.urlLabel,
      COPY.nameLabel,
      COPY.credentialLabel,
      COPY.riskLabel,
    ]) {
      expect(field(label)).toBeTruthy();
    }
    // No credential to name until a kind takes one.
    expect(text()).not.toContain(COPY.secretLabel);
    await type(COPY.urlLabel, "https://mcp.deepwiki.com/mcp");
    expect(field(COPY.nameLabel).getAttribute("placeholder")).toBe("deepwiki");
    expect(text()).toContain(COPY.nameHelp("deepwiki"));
    expect(text()).toContain(COPY.riskItems[0]!.help);

    await press(button(COPY.back));
    expect(text()).toContain(FIRST_SCREEN.addApp.dialogTitle);
  });

  it("prefills the credential's name from the app's and checks an edited one with the shared rule", async () => {
    await openForm();
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await choose(COPY.credentialLabel, "Bearer token");
    const secret = field(COPY.secretLabel) as HTMLInputElement;
    expect(secret.value).toBe("TREG_MCP_TOKEN");
    // Follows the name until edited.
    await type(COPY.nameLabel, "my-docs");
    expect((field(COPY.secretLabel) as HTMLInputElement).value).toBe(
      "MY_DOCS_MCP_TOKEN",
    );

    await type(COPY.secretLabel, "OPENAI_API_KEY");
    expect(text()).toContain(
      "The credential's name must end in _MCP_TOKEN (letters, digits and underscores), like TREG_MCP_TOKEN.",
    );
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).not.toHaveBeenCalled();

    await type(COPY.secretLabel, "DOCS_MCP_TOKEN");
    expect(text()).not.toContain("must end in _MCP_TOKEN");
  });

  it("refuses an empty URL and a name the rule refuses before sending anything", async () => {
    await openForm();
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
        authKind: "header",
        secret: "DOCS_MCP_TOKEN",
        setupCommand: "pnpm everyapp secret set DOCS_MCP_TOKEN",
        toolCount: null,
        toolsStatus: null,
      }),
    );
    await openForm();
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
        auth: { kind: "header", secret: "DOCS_MCP_TOKEN", header: "X-Api-Key" },
        risk: "read",
      },
    });
    expect(onAdded).toHaveBeenCalledOnce();
  });

  it("shows the credential's command once a credentialed server is added", async () => {
    mocks.addRemoteMcpApp.mockResolvedValue(
      added({
        name: "Treg",
        authKind: "bearer",
        secret: "TREG_MCP_TOKEN",
        setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
        toolCount: null,
        toolsStatus: null,
      }),
    );
    await openForm();
    await type(COPY.urlLabel, "https://treg.to/mcp/");
    await choose(COPY.credentialLabel, "Bearer token");
    await press(button(COPY.submit));
    expect(mocks.addRemoteMcpApp).toHaveBeenCalledWith({
      data: {
        url: "https://treg.to/mcp/",
        auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
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
    await openForm();
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
    await openForm();
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
    await openForm();
    await type(COPY.urlLabel, "http://treg.to/mcp/");
    await press(button(COPY.submit));
    const alert = dialog().querySelector('[role="alert"], [data-slot="alert"]');
    expect(alert?.textContent).toContain("The URL must be https://.");
    // Still the form, to fix and try again.
    expect(field(COPY.urlLabel)).toBeTruthy();
  });
});
