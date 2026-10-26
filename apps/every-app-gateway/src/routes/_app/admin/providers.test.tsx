// @vitest-environment happy-dom
/**
 * Manage workspace → Providers rendered for real (React in a DOM) with the
 * server functions mocked: what is set up lists first, then what an app
 * needs and lacks, and the rest of the catalog behind Show all, never a
 * Gateway service; the full table says where each OAuth client comes
 * from and never a value; Add OAuth provider lists the presets with the
 * built-in ones marked, and picking GitHub shows the redirect URI to
 * register; a registered row's menu offers Replace client and Remove; the
 * Connections table lists the organization's with Disconnect.
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
    flow: "both",
    client: { source: "d1", clientId: "Iv1.public", addedBy: "ada@acme.com" },
    bound: true,
    redirectUri: REDIRECT,
    scopeSets: [{ name: "repo.read", label: "Repositories", access: "read" }],
    console: "https://github.com/settings/developers",
    connections: 2,
    settings: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
  },
};
const google = {
  id: "google-workspace",
  name: "Google Workspace",
  source: "catalog",
  kind: "oauth",
  hosts: ["www.googleapis.com"],
  configured: true,
  settings: ["GOOGLE_WORKSPACE_CLIENT_ID", "GOOGLE_WORKSPACE_CLIENT_SECRET"],
  apps: [],
  oauth: {
    ...github.oauth,
    id: "google-workspace",
    name: "Google Workspace",
    source: "catalog",
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
    builtIn: true,
    description: "Search Console, Analytics, Gmail.",
    hint: null,
    console: "https://console.cloud.google.com/apis/credentials",
    scopeSets: [],
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
    builtIn: false,
    description: "Repositories, issues, pull requests.",
    hint: "Register an OAuth App (not a GitHub App).",
    console: "https://github.com/settings/developers",
    scopeSets: [{ name: "repo.read", label: "Repositories", access: "read" }],
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
    account: "user",
    userId: "user_1",
    userEmail: "ada@acme.com",
    label: "ada",
    scopeSets: ["identity", "repo.read"],
    status: "active",
    createdAt: Date.now() - 86_400_000,
    lastUsedAt: Date.now() - 3_600_000,
    expiresAt: Date.now() + 3_600_000,
  },
  {
    id: "conn_2",
    providerId: "github-oauth",
    providerName: "GitHub",
    account: "organization",
    label: "acme-bot",
    scopeSets: ["repo.read"],
    status: "expired",
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
    providers: [openrouter, google, slack, dataforseo, exa, email, github],
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

function group(title: string) {
  return container.querySelector(`ul[aria-label="${title}"]`);
}

function rowNames(title: string): string[] {
  return [...(group(title)?.querySelectorAll("li") ?? [])].map(
    (row) => row.querySelector("p")?.textContent ?? "",
  );
}

async function showAll() {
  await press(button("Show all providers"));
}

describe("the grouped list", () => {
  it("lists what is set up first, then what an app needs, and folds the rest away, never a Gateway service", async () => {
    await render();
    expect(rowNames("Set up")).toEqual([
      "OpenRouter",
      "Google Workspace",
      "GitHub",
    ]);
    expect(body()).toContain("Set up · 3");
    const setUp = group("Set up")!.textContent ?? "";
    expect(setUp).toContain("AI · AI default");
    expect(setUp).toContain(
      "OAuth · registered here · 2 connections · used by crm",
    );
    expect(setUp).toContain("Ready");
    expect(rowNames("Needed by an app")).toEqual(["DataForSEO"]);
    const needed = group("Needed by an app")!.textContent ?? "";
    expect(needed).toContain("API key · needed by notes");
    expect(needed).toContain("Needs a key");
    expect(body()).toContain("2 more built in: APIs, OAuth sign-ins");
    expect(container.querySelector('[aria-label="All providers"]')).toBeNull();
    expect(body()).not.toContain("Slack");
    expect(body()).not.toContain("Gateway service");
  });

  it("shows the terminal command, never a field, for a key an app needs", async () => {
    await render();
    await press(button("Set up", group("Needed by an app")!));
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
    expect(rowNames("Needed by an app")).toEqual(["Slack"]);
    expect(group("Needed by an app")!.textContent).toContain("Needs a client");
    await press(button("Set up", group("Needed by an app")!));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Slack");
    expect(dialog.textContent).toContain(slack.oauth.redirectUri);
  });

  it("says nothing is set up on a fresh workspace, and still offers Show all", async () => {
    mocks.listProviders.mockResolvedValue({ providers: [exa, slack, email] });
    await render();
    expect(group("Set up")).toBeNull();
    expect(group("Needed by an app")).toBeNull();
    expect(body()).toContain("Nothing is set up yet.");
    expect(body()).toContain("2 more built in: APIs, OAuth sign-ins");
    await showAll();
    expect(
      container.querySelectorAll('[aria-label="All providers"] tbody tr'),
    ).toHaveLength(2);
  });

  it("expands to every provider but the Gateway services, and filters by name", async () => {
    await render();
    await showAll();
    const rows = () =>
      [
        ...container.querySelectorAll('[aria-label="All providers"] tbody tr'),
      ].map((row) => row.querySelector("p")?.textContent);
    expect(rows()).toHaveLength(6);
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

  it("offers Replace client, Forget pasted client, Connect for the organization and Remove on a registered row", async () => {
    await render();
    await showAll();
    await openRowMenu("GitHub");
    expect(menuItems()).toEqual([
      "Replace client",
      "Forget pasted client",
      "Connect for the organization",
      "Remove provider",
    ]);
    const connect = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) =>
        element.textContent?.includes("Connect for the organization"),
    );
    expect(connect?.getAttribute("href")).toBe(
      "/connect/github-oauth?account=organization&return=%2Fadmin%2Fproviders",
    );
  });

  it("offers no Remove on a built-in client, and no menu on an API-key entry", async () => {
    await render();
    await showAll();
    await openRowMenu("Google Workspace");
    expect(menuItems()).toEqual([
      "Replace client",
      "Connect for the organization",
    ]);
    expect(
      container.querySelector(
        'table button[aria-label="Actions for DataForSEO"]',
      ),
    ).toBeNull();
  });
});

describe("Add OAuth provider", () => {
  it("lists the presets with the built-in ones marked, then shows GitHub's redirect URI and takes the client", async () => {
    await render();
    await press(button("Add OAuth provider"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const list = dialog.querySelector('[aria-label="Presets"]')!.textContent!;
    expect(list).toContain("Google WorkspaceBuilt in");
    expect(list).toContain("GitHub");
    expect(list).toContain("Custom");

    await press(
      [...dialog.querySelectorAll("button")].find((element) =>
        element.textContent?.startsWith("GitHub"),
      )!,
    );
    const step = document.body.querySelector('[role="dialog"]')!;
    expect(step.textContent).toContain(REDIRECT);
    expect(step.textContent).toContain("repo.read");
    expect(step.textContent).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    const secret = [...step.querySelectorAll("input")].find(
      (input) => input.type === "password",
    );
    expect(secret, "the secret field hides what is typed").toBeDefined();
  });
});

describe("the connections table", () => {
  it("lists each person's and the organization's connections with their state", async () => {
    await render();
    const tables = container.querySelectorAll("table");
    const text = tables[0]!.textContent ?? "";
    expect(text).toContain("ada@acme.com");
    expect(text).toContain("The organization");
    expect(text).toContain("identity, repo.read");
    expect(text).toContain("Connected");
    expect(text).toContain("Needs reconnecting");
  });
});
