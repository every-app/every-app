// @vitest-environment happy-dom
/**
 * Manage workspace → Providers rendered for real (React in a DOM) with the
 * server functions mocked: one searchable table lists every provider, what
 * needs setting up first, then what is set up, then the rest, the ones
 * more apps list first in each, never
 * a Gateway service, and never a client's value; every row has a menu,
 * whose terminal-set key, client or provider shows the command, and Remove
 * provider on a registered row, disabled while an app on the Gateway lists
 * it; Add OAuth provider lists
 * the presets, and picking GitHub shows the redirect URI to register; the
 * searchable Organization connections table lists the organization's, each
 * one person's to one provider with the apps allowed to use it and its
 * scopes folded to the first, one app's access taken away by the
 * connection's id and the app's row id, and Disconnect. No scope sets, no
 * organization connect, no background.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listProviders: vi.fn(),
  listOAuthPresets: vi.fn(),
  addOAuthProvider: vi.fn(),
  setOAuthClient: vi.fn(),
  removeOAuthClient: vi.fn(),
  removeProvider: vi.fn(),
  listAllConnections: vi.fn(),
  disconnectConnection: vi.fn(),
  removeConnectionApp: vi.fn(),
  getAiDefault: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({ options }),
}));
vi.mock("@/serverFunctions/providers", () => ({
  listProviders: mocks.listProviders,
  listOAuthPresets: mocks.listOAuthPresets,
  addOAuthProvider: mocks.addOAuthProvider,
  setOAuthClient: mocks.setOAuthClient,
  removeOAuthClient: mocks.removeOAuthClient,
  removeProvider: mocks.removeProvider,
}));
vi.mock("@/serverFunctions/connections", () => ({
  listAllConnections: mocks.listAllConnections,
  disconnectConnection: mocks.disconnectConnection,
  removeConnectionApp: mocks.removeConnectionApp,
}));
vi.mock("@/serverFunctions/ai", () => ({
  getAiDefault: mocks.getAiDefault,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { Route } from "./providers";

const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

const REDIRECT = "https://apps.acme.com/connect/github-oauth/callback";

const github = {
  id: "github-oauth",
  name: "GitHub",
  source: "row",
  kind: "oauth",
  hosts: ["api.github.com"],
  configured: true,
  settings: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
  apps: [{ rowId: "app_crm", name: "crm", needs: false }],
  inUse: true,
  oauth: {
    id: "github-oauth",
    name: "GitHub",
    source: "row",
    kind: "oauth",
    client: { source: "d1", clientId: "Iv1.public", addedBy: "ada@acme.com" },
    bound: true,
    redirectUri: REDIRECT,
    hosts: ["api.github.com"],
    console: "https://github.com/settings/developers",
    connections: 2,
    settings: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
  },
};
const google = {
  id: "google-workspace",
  name: "Google Workspace",
  source: "row",
  kind: "oauth",
  hosts: ["www.googleapis.com"],
  configured: true,
  settings: ["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_WORKSPACE_CLIENT_SECRET"],
  apps: [],
  oauth: {
    ...github.oauth,
    id: "google-workspace",
    name: "Google Workspace",
    source: "row",
    client: { source: "env", clientId: "123.apps" },
    redirectUri: "https://apps.acme.com/connect/google-workspace/callback",
    connections: 0,
    settings: ["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_WORKSPACE_CLIENT_SECRET"],
  },
};
const dataforseo = {
  id: "dataforseo",
  name: "DataForSEO",
  source: "catalog",
  kind: "api_key",
  hosts: ["api.dataforseo.com"],
  configured: false,
  settings: ["DATAFORSEO_API_KEY"],
  apps: [{ rowId: "app_notes", name: "notes", needs: true }],
};
const openrouter = {
  id: "openrouter",
  name: "OpenRouter",
  source: "catalog",
  kind: "ai",
  hosts: [],
  configured: true,
  settings: ["OPENROUTER_API_KEY"],
  apps: [],
};
const exa = {
  id: "exa",
  name: "Exa",
  source: "catalog",
  kind: "api_key",
  hosts: ["api.exa.ai"],
  configured: false,
  settings: ["EXA_API_KEY"],
  apps: [],
};
const slack = {
  ...google,
  id: "slack",
  name: "Slack",
  configured: false,
  apps: [],
  oauth: {
    ...google.oauth,
    id: "slack",
    name: "Slack",
    client: { source: null },
  },
};
const email = {
  id: "email",
  name: "email",
  source: "catalog",
  kind: "service",
  hosts: [],
  configured: true,
  settings: [],
  apps: [],
};

const presets = [
  {
    id: "google-workspace",
    name: "Google Workspace",
    description: "Search Console, Analytics, Gmail.",
    hint: null,
    console: "https://console.cloud.google.com/apis/credentials",
    settings: {
      clientId: "GOOGLE_WORKSPACE_CLIENT_ID",
      clientSecret: "GOOGLE_WORKSPACE_CLIENT_SECRET",
    },
    pkce: true,
    hosts: ["www.googleapis.com"],
    redirectUri: "https://apps.acme.com/connect/google-workspace/callback",
  },
  {
    id: "github-oauth",
    name: "GitHub",
    description: "Repositories, issues, pull requests.",
    hint: "An OAuth App, not a `GitHub App`.",
    console: "https://github.com/settings/developers",
    settings: {
      clientId: "GITHUB_OAUTH_CLIENT_ID",
      clientSecret: "GITHUB_OAUTH_CLIENT_SECRET",
    },
    pkce: true,
    hosts: ["api.github.com"],
    redirectUri: REDIRECT,
  },
];

const connections = [
  {
    id: "conn_1",
    providerId: "github-oauth",
    providerName: "GitHub",
    userId: "user_1",
    userEmail: "ada@acme.com",
    apps: [
      { rowId: "app_ci", id: "ci", name: "CI" },
      { rowId: "app_crm", id: "crm", name: "CRM" },
    ],
    label: "ada",
    scopes: ["repo", "read:user"],
    status: "active",
    needsReconnect: false,
    createdAt: Date.now() - 86_400_000,
    lastUsedAt: Date.now() - 3_600_000,
    expiresAt: Date.now() + 3_600_000,
  },
  {
    id: "conn_2",
    providerId: "github-oauth",
    providerName: "GitHub",
    userId: "user_2",
    userEmail: "bo@acme.com",
    apps: [],
    label: "bo",
    scopes: [],
    status: "expired",
    needsReconnect: false,
    createdAt: Date.now() - 86_400_000,
    lastUsedAt: null,
    expiresAt: null,
  },
];

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

async function settle() {
  for (let tick = 0; tick < 8; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Page />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    if (typeof fn === "function") fn.mockReset();
  }
  mocks.listProviders.mockResolvedValue({
    providers: [openrouter, google, dataforseo, exa, email, github],
  });
  mocks.getAiDefault.mockResolvedValue({
    resolution: { provider: "openrouter", configured: true },
    choice: null,
    aiGateway: { on: false },
  });
  mocks.listOAuthPresets.mockResolvedValue({ presets });
  mocks.listAllConnections.mockResolvedValue({ connections });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const body = () => document.body.textContent ?? "";

function button(label: string, scope: Element = document.body) {
  const found = [...scope.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function openRowMenu(name: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    `table button[aria-label="Actions for ${name}"]`,
  )!;
  await press(trigger);
}

function menuItems(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (element) => element.textContent?.trim() ?? "",
  );
}

/** The page's tables: providers, then connections. */
function table(index: 0 | 1): HTMLTableElement {
  return container.querySelectorAll("table")[index]!;
}

function providerRows(): HTMLTableRowElement[] {
  return [...table(0).querySelectorAll<HTMLTableRowElement>("tbody tr")];
}

function rowNames(): string[] {
  return providerRows().map((row) => row.querySelector("p")?.textContent ?? "");
}

function providerRow(name: string): HTMLTableRowElement {
  const row = providerRows().find(
    (element) => element.querySelector("p")?.textContent === name,
  );
  if (!row) throw new Error(`no ${name} row`);
  return row;
}

/** A provider's cells: provider over its kind, apps, status, Set up, menu. */
function cells(name: string): string[] {
  return [...providerRow(name).querySelectorAll("td")].map(
    (cell) => cell.textContent?.trim() ?? "",
  );
}

async function search(label: string, text: string) {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

async function pressMenuItem(label: string) {
  await press(
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === label,
    )!,
  );
}

const dialogText = () =>
  document.body.querySelector('[role="alertdialog"], [role="dialog"]')
    ?.textContent ?? "";

describe("the providers table", () => {
  it("lists every provider, what needs setting up first, then what is set up, then the rest, more apps first in each, never a Gateway service", async () => {
    await render();
    expect(rowNames()).toEqual([
      "DataForSEO",
      "GitHub",
      "Google Workspace",
      "OpenRouter",
      "Exa",
    ]);
    expect(cells("OpenRouter").slice(0, 3)).toEqual([
      "OpenRouteropenrouter · AI default",
      "none",
      "Ready",
    ]);
    expect(cells("GitHub").slice(0, 3)).toEqual([
      "GitHubgithub-oauth · OAuth",
      "crm",
      "Ready",
    ]);
    expect(cells("DataForSEO").slice(0, 3)).toEqual([
      "DataForSEOdataforseo · API key",
      "notes",
      "Needs setup",
    ]);
    expect(cells("Exa").slice(0, 3)).toEqual([
      "Exaexa · API key",
      "none",
      "Not set",
    ]);
    expect(body()).not.toContain("Show all");
    expect(body()).not.toContain("Gateway service");
    expect(body()).not.toContain("Iv1.public");
  });

  it("filters by name, kind or app", async () => {
    await render();
    await search("Search providers", "goo");
    expect(rowNames()).toEqual(["Google Workspace"]);
    await search("Search providers", "notes");
    expect(rowNames()).toEqual(["DataForSEO"]);
    await search("Search providers", "nothing like it");
    expect(body()).toContain("No providers match");
  });

  it("shows the terminal command, never a field, for a key an app needs", async () => {
    await render();
    await press(button("Set up", providerRow("DataForSEO")));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Set the DataForSEO key");
    expect(dialog.querySelector("[data-slot='dialog-description']")).toBeNull();
    expect(dialog.textContent).toContain(
      "pnpm everyapp secret set DATAFORSEO_API_KEY",
    );
    expect(dialog.textContent).toContain(
      "Apps can use this key only to call api.dataforseo.com.",
    );
    expect(dialog.querySelector("input")).toBeNull();
    expect(dialog.querySelector("a")?.getAttribute("href")).toBe(
      "https://everyapp.com/docs/providers/dataforseo",
    );
  });

  it("opens the client dialog for an OAuth provider an app needs", async () => {
    mocks.listProviders.mockResolvedValue({
      providers: [
        {
          ...slack,
          apps: [{ rowId: "app_chat", name: "chat", needs: true }],
        },
      ],
    });
    await render();
    expect(rowNames()).toEqual(["Slack"]);
    expect(cells("Slack")[2]).toBe("Needs setup");
    await press(button("Set up", providerRow("Slack")));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Slack");
    expect(dialog.textContent).toContain(slack.oauth.redirectUri);
    expect(dialog.textContent).toContain(
      `Apps can use connected accounts only to call ${slack.oauth.hosts.join(", ")}.`,
    );
  });
});

describe("a provider's menu", () => {
  it("disables Remove on a registered row an app on the Gateway lists", async () => {
    await render();
    await openRowMenu("GitHub");
    expect(menuItems()).toEqual([
      "Replace client",
      "Remove client",
      "Remove provider",
    ]);
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent?.startsWith("Remove provider"),
    )!;
    expect(remove.hasAttribute("data-disabled")).toBe(true);
  });

  it("removes a terminal-set client from the terminal, and a registered row no app lists here", async () => {
    mocks.removeProvider.mockResolvedValue(undefined);
    await render();
    await openRowMenu("Google Workspace");
    expect(menuItems()).toEqual([
      "Replace client",
      "Remove client",
      "Remove provider",
    ]);
    await pressMenuItem("Remove client");
    expect(dialogText()).toContain(
      "pnpm everyapp secret unset GOOGLE_WORKSPACE_CLIENT_ID GOOGLE_WORKSPACE_CLIENT_SECRET",
    );
    await press(button("Close", document.querySelector('[role="dialog"]')!));

    await openRowMenu("Google Workspace");
    await pressMenuItem("Remove provider");
    expect(dialogText()).toContain("Its OAuth client is deleted.");
    await press(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="alertdialog"] button',
        ),
      ].find((element) => element.textContent?.trim() === "Remove provider")!,
    );
    expect(mocks.removeProvider.mock.calls[0]![0]).toEqual({
      data: { providerId: "google-workspace" },
    });
  });

  it("sets a built-in key from the terminal, and removes it there once set", async () => {
    await render();
    await openRowMenu("DataForSEO");
    expect(menuItems()).toEqual(["Set key"]);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    await openRowMenu("OpenRouter");
    expect(menuItems()).toEqual(["Replace key", "Remove key"]);
    await pressMenuItem("Remove key");
    expect(dialogText()).toContain(
      "pnpm everyapp secret unset OPENROUTER_API_KEY",
    );
  });

  it("removes a provider registered from the terminal there", async () => {
    const acme = {
      ...exa,
      id: "acme",
      name: "Acme",
      source: "row",
      configured: true,
      settings: ["ACME_API_KEY"],
      setFromTerminal: true,
    };
    mocks.listProviders.mockResolvedValue({ providers: [acme] });
    await render();
    await openRowMenu("Acme");
    expect(menuItems()).toEqual([
      "Replace key",
      "Remove key",
      "Remove provider",
    ]);
    await pressMenuItem("Remove provider");
    expect(dialogText()).toContain("pnpm everyapp provider remove acme");
    expect(dialogText()).toContain("pnpm everyapp secret unset ACME_API_KEY");
    expect(mocks.removeProvider).not.toHaveBeenCalled();
  });
});

describe("Add OAuth provider", () => {
  it("lists the presets, then shows GitHub's redirect URI and takes the client", async () => {
    await render();
    await press(button("Add OAuth provider"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const list = dialog.querySelector('[aria-label="Presets"]')!.textContent!;
    expect(list).toContain("Google Workspace");
    expect(list).not.toContain("Built in");
    expect(list).toContain("GitHub");
    expect(dialog.querySelector("[data-slot='dialog-description']")).toBeNull();
    const rowOf = (name: string) =>
      [...dialog.querySelectorAll("tbody tr")].find((row) =>
        row.textContent?.startsWith(name),
      );
    expect(
      rowOf("GitHub")?.querySelector("svg"),
      "a preset shows its brand mark",
    ).toBeTruthy();
    expect(button("Custom provider", dialog)).toBeTruthy();

    await search("Search presets", "repositories");
    expect(
      [...dialog.querySelectorAll("tbody tr")].map(
        (row) => row.querySelector("button")?.textContent,
      ),
    ).toEqual(["GitHub"]);
    await search("Search presets", "nothing like it");
    expect(dialog.textContent).toContain("No presets match");
    expect(button("Custom provider", dialog)).toBeTruthy();
    await search("Search presets", "repositories");

    await press(
      [...dialog.querySelectorAll("button")].find((element) =>
        element.textContent?.startsWith("GitHub"),
      )!,
    );
    const step = document.body.querySelector('[role="dialog"]')!;
    expect(step.textContent).toContain(REDIRECT);
    expect(step.textContent).not.toMatch(/scope set/i);
    expect(
      step.querySelector("[data-slot='dialog-description'] code")?.textContent,
      "a hint's backticked words read as code",
    ).toBe("GitHub App");
    expect(step.textContent).toContain(
      "Apps can use connected accounts only to call api.github.com.",
    );
    expect(step.textContent).toContain(
      "Leave both blank to set the client later.",
    );
    expect(step.textContent, "no terminal alternative").not.toContain(
      "GITHUB_OAUTH_CLIENT_SECRET",
    );
    expect(
      step.querySelector("[data-slot='field-description']"),
      "no hints under the fields",
    ).toBeNull();
    const secret = [...step.querySelectorAll("input")].find(
      (input) => input.type === "password",
    );
    expect(secret, "the secret field hides what is typed").toBeDefined();
  });
});

describe("the presets", () => {
  it("pages six at a time", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...presets[1]!,
      id: `preset-${index}`,
      name: `Preset ${index}`,
    }));
    mocks.listOAuthPresets.mockResolvedValue({ presets: many });
    await render();
    await press(button("Add OAuth provider"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const names = () =>
      [...dialog.querySelectorAll("tbody tr")].map(
        (row) => row.querySelector("button")?.textContent,
      );
    expect(names()).toHaveLength(6);
    expect(dialog.textContent).toContain("1–6 of 8");
    await press(
      dialog.querySelector<HTMLElement>('[aria-label="Go to next page"]')!,
    );
    expect(names()).toEqual(["Preset 6", "Preset 7"]);
  });
});

describe("the connections table", () => {
  /** A connection's cells, by the person it belongs to. */
  function connectionRow(person: string): string[] {
    const row = [...container.querySelectorAll("table tbody tr")].find(
      (element) => element.textContent?.includes(person),
    );
    if (!row) throw new Error(`no connection for ${person}`);
    return [...row.querySelectorAll("td")].map(
      (cell) => cell.textContent?.trim() ?? "",
    );
  }

  /** Press the open confirmation's button. */
  async function confirm(label: string) {
    const dialog = document.body.querySelector(
      '[role="alertdialog"], [role="dialog"]',
    )!;
    await press(
      [...dialog.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === label,
      )!,
    );
  }

  it("lists each connection with its person, the apps allowed to use it, scopes and state", async () => {
    await render();
    expect(connectionRow("ada@acme.com").slice(0, 5)).toEqual([
      "ada@acme.comada",
      "GitHub",
      "CICRM",
      "repo+1 more",
      "Connected",
    ]);
    expect(connectionRow("bo@acme.com").slice(0, 5)).toEqual([
      "bo@acme.combo",
      "GitHub",
      "none",
      "no scopes",
      "Expired",
    ]);
    expect(body()).not.toMatch(/organization's|background|each app/i);
  });

  it("opens a connection's scopes, and folds them again", async () => {
    await render();
    await press(button("+1 more", table(1)));
    expect(connectionRow("ada@acme.com")[3]).toBe("repo, read:userShow less");
    await press(button("Show less", table(1)));
    expect(connectionRow("ada@acme.com")[3]).toBe("repo+1 more");
  });

  it("filters by person, provider or app", async () => {
    await render();
    await search("Search connections", "bo@");
    expect(table(1).querySelectorAll("tbody tr")).toHaveLength(1);
    expect(connectionRow("bo@acme.com")[0]).toBe("bo@acme.combo");
    await search("Search connections", "crm");
    expect(connectionRow("ada@acme.com")[0]).toBe("ada@acme.comada");
    expect(table(1).querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("takes one app's access away by the connection's id and the app's row id, then lists again", async () => {
    mocks.removeConnectionApp.mockResolvedValue({ ok: true });
    await render();
    await press(
      container.querySelector<HTMLButtonElement>(
        `table button[aria-label="Remove CRM's access"]`,
      )!,
    );
    expect(body()).toContain("Remove CRM's access to ada@acme.com's GitHub?");
    expect(mocks.removeConnectionApp).not.toHaveBeenCalled();
    await confirm("Remove access");
    expect(mocks.removeConnectionApp).toHaveBeenCalledOnce();
    expect(mocks.removeConnectionApp.mock.calls[0]![0]).toEqual({
      data: { connectionId: "conn_1", appRowId: "app_crm" },
    });
    expect(mocks.disconnectConnection).not.toHaveBeenCalled();
    expect(mocks.listAllConnections).toHaveBeenCalledTimes(2);
  });

  it("disconnects one by its id, and says every app stops", async () => {
    mocks.disconnectConnection.mockResolvedValue({ ok: true, revoked: true });
    await render();
    await press(
      container.querySelector<HTMLButtonElement>(
        `table button[aria-label="Actions for bo@acme.com's GitHub connection"]`,
      )!,
    );
    const disconnect = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent?.includes("Disconnect"),
    ) as HTMLElement;
    await press(disconnect);
    expect(body()).toContain("Disconnect bo@acme.com's GitHub?");
    expect(body()).toContain(
      "Every app stops using this person's account at once.",
    );
    await confirm("Disconnect");
    expect(mocks.disconnectConnection.mock.calls[0]![0]).toEqual({
      data: { connectionId: "conn_2" },
    });
    expect(mocks.removeConnectionApp).not.toHaveBeenCalled();
  });
});

describe("rows this build can't fully read", () => {
  it("lists rows from an older Gateway build (no configured, settings or apps) instead of blanking the tab", async () => {
    // The pre-#790 shape, as a list persisted in the browser by that build.
    const old = ({
      configured,
      settings,
      apps,
      ...rest
    }: {
      configured: boolean;
      settings: string[];
      apps: unknown[];
    } & Record<string, unknown>) => {
      void [configured, settings, apps];
      return rest;
    };
    mocks.listProviders.mockResolvedValue({
      providers: [old(exa), old(dataforseo), github, email],
    });
    await render();
    expect(body()).not.toContain("Something went wrong");
    expect(rowNames()).toEqual(["GitHub", "DataForSEO", "Exa"]);
    expect(cells("DataForSEO")[2]).toBe("Not set");
  });

  it("shows a row that fails to render with its name and a line where a cell failed, and the rest of the page as usual", async () => {
    const broken = { ...google, id: "broken", name: "Broken", apps: [null] };
    mocks.listProviders.mockResolvedValue({
      providers: [openrouter, broken, dataforseo],
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    quiet.mockRestore();
    expect(rowNames()).toEqual(["DataForSEO", "Broken", "OpenRouter"]);
    expect(providerRow("Broken").textContent).toContain("Couldn't show this");
    expect(cells("DataForSEO")[2]).toBe("Needs setup");
  });
});
