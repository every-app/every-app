// @vitest-environment happy-dom
/**
 * Manage workspace → Providers rendered for real (React in a DOM) with the
 * server functions mocked: one table lists what is set up first, then what
 * still needs setting up, with the rest of the catalog behind Show all,
 * never a Gateway service; it says where each OAuth client comes from and
 * never a value; Add OAuth provider lists the presets with the built-in
 * ones marked, and picking GitHub shows the redirect URI to register; a
 * registered row's menu offers Replace client and Remove; the Organization
 * connections table lists the organization's, each one person's to one
 * provider with the apps allowed to use it, one app's access taken away
 * by the connection's id and the app's row id, and Disconnect. No scope
 * sets, no organization connect, no background.
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
  apps: [{ name: "crm", needs: false }],
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
  apps: [{ name: "notes", needs: true }],
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
    hint: "Register an OAuth App (not a GitHub App).",
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

/** The providers table's rows: it is the page's first table while it lists any. */
function providerRows(): HTMLTableRowElement[] {
  return [
    ...container
      .querySelector("table")!
      .querySelectorAll<HTMLTableRowElement>("tbody tr"),
  ];
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

/**
 * A provider's cells: provider, kind over where it comes from, apps, status,
 * client over its connections (or the hosts), Set up, menu.
 */
function cells(name: string): string[] {
  return [...providerRow(name).querySelectorAll("td")].map(
    (cell) => cell.textContent?.trim() ?? "",
  );
}

async function showAll() {
  await press(button("Show all"));
}

describe("the providers before Show all", () => {
  it("lists what is set up first, then what still needs setting up, and folds the rest away, never a Gateway service", async () => {
    await render();
    expect(rowNames()).toEqual([
      "OpenRouter",
      "Google Workspace",
      "GitHub",
      "DataForSEO",
    ]);
    expect(cells("OpenRouter").slice(1, 4)).toEqual([
      "AI defaultBuilt in",
      "none",
      "Ready",
    ]);
    expect(cells("GitHub").slice(1, 5)).toEqual([
      "OAuthRegistered here",
      "crm",
      "Ready",
      "Pasted here2 connections",
    ]);
    expect(cells("DataForSEO").slice(1, 5)).toEqual([
      "API keyBuilt in",
      "notes",
      "Needs setup",
      "api.dataforseo.com",
    ]);
    expect(body()).toContain("1 more provider available");
    expect(
      container.querySelector('input[aria-label="Search providers"]'),
    ).toBeNull();
    expect(body()).not.toContain("Slack");
    expect(body()).not.toContain("Gateway service");
  });

  it("shows the terminal command, never a field, for a key an app needs", async () => {
    await render();
    await press(button("Set up", providerRow("DataForSEO")));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Set up DataForSEO");
    expect(dialog.textContent).toContain("notes needs it.");
    expect(dialog.textContent).toContain(
      "pnpm everyapp secret set DATAFORSEO_API_KEY",
    );
    expect(dialog.querySelector("input")).toBeNull();
    expect(dialog.querySelector("a")?.getAttribute("href")).toBe(
      "https://everyapp.com/docs/providers/dataforseo",
    );
  });

  it("opens the client dialog for an OAuth provider an app needs", async () => {
    mocks.listProviders.mockResolvedValue({
      providers: [{ ...slack, apps: [{ name: "chat", needs: true }] }],
    });
    await render();
    expect(rowNames()).toEqual(["Slack"]);
    expect(cells("Slack")[3]).toBe("Needs setup");
    await press(button("Set up", providerRow("Slack")));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Slack");
    expect(dialog.textContent).toContain(slack.oauth.redirectUri);
  });

  it("says nothing is set up on a fresh workspace, and still offers Show all", async () => {
    // An OAuth preset isn't listed until a deploy or an admin registers it.
    mocks.listProviders.mockResolvedValue({ providers: [exa, email] });
    await render();
    expect(body()).toContain("Nothing is set up yet");
    expect(body()).not.toContain("Exa");
    await showAll();
    expect(rowNames()).toEqual(["Exa"]);
  });

  it("expands to every provider but the Gateway services, and filters by name", async () => {
    await render();
    await showAll();
    const rows = rowNames;
    expect(rows()).toHaveLength(5);
    expect(rows()).not.toContain("email");
    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search providers"]',
    )!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setValue.call(search, "goo");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(rows()).toEqual(["Google Workspace"]);
  });
});

describe("the providers table", () => {
  it("says where each client comes from, counts connections, and never shows a secret", async () => {
    await render();
    await showAll();
    const table = container.querySelector("table")!.textContent ?? "";
    expect(table).toContain("GitHub");
    expect(table).toContain("Pasted here");
    expect(table).toContain("Set from the terminal");
    expect(table).toContain("Registered here");
    expect(table).toContain("Built in");
    expect(table).toContain("api.dataforseo.com");
    expect(table).toContain("Ready");
    expect(table).toContain("Not set");
    expect(body()).not.toContain("Iv1.public");
  });

  it("offers Replace client, Forget pasted client and Remove on a registered row, and no way to connect", async () => {
    await render();
    await showAll();
    await openRowMenu("GitHub");
    expect(menuItems()).toEqual([
      "Replace client",
      "Forget pasted client",
      "Remove provider",
    ]);
  });

  it("offers Remove on an OAuth preset's row, and no menu on a built-in API-key entry", async () => {
    await render();
    await showAll();
    await openRowMenu("Google Workspace");
    expect(menuItems()).toEqual(["Replace client", "Remove provider"]);
    expect(
      container.querySelector(
        'table button[aria-label="Actions for DataForSEO"]',
      ),
    ).toBeNull();
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
    expect(list).toContain("Custom");

    await press(
      [...dialog.querySelectorAll("button")].find((element) =>
        element.textContent?.startsWith("GitHub"),
      )!,
    );
    const step = document.body.querySelector('[role="dialog"]')!;
    expect(step.textContent).toContain(REDIRECT);
    expect(step.textContent).not.toMatch(/scope set/i);
    expect(step.textContent).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    const secret = [...step.querySelectorAll("input")].find(
      (input) => input.type === "password",
    );
    expect(secret, "the secret field hides what is typed").toBeDefined();
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
      "repo, read:user",
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
    expect(rowNames()).toEqual(["GitHub"]);
    expect(body()).toContain("2 more providers available");
    await showAll();
    const table = container.querySelector("table")!.textContent ?? "";
    expect(table).toContain("Exa");
    expect(table).toContain("DataForSEO");
  });

  it("shows a row that fails to render with its name and a line where a cell failed, and the rest of the page as usual", async () => {
    const broken = { ...google, id: "broken", name: "Broken", oauth: {} };
    mocks.listProviders.mockResolvedValue({
      providers: [openrouter, broken, dataforseo],
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    quiet.mockRestore();
    expect(rowNames()).toEqual(["OpenRouter", "Broken", "DataForSEO"]);
    expect(providerRow("Broken").textContent).toContain("Couldn't show this");
    expect(cells("DataForSEO")[3]).toBe("Needs setup");
  });
});
