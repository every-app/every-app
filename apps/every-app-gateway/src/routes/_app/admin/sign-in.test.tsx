// @vitest-environment happy-dom
/**
 * Manage workspace → Sign-in rendered for real (React in a DOM) with the
 * server function mocked: each provider reads On, Needs setup or Off with
 * Set up; the dialog shows the redirect URL, the settings with which are
 * set, the command and who runs it; the page has nothing that changes a
 * setting, and no value is ever on it.
 */
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIGN_IN_PROVIDER_LIST,
  signInCallbackUrl,
  type SignInProviderStatus,
} from "@every-app/sdk/internal";
import type {
  ListedSignInProvider,
  SignInProvidersListing,
} from "@/server/sign-in-providers";

const mocks = vi.hoisted(() => ({
  listSignInProviders: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({ options }),
}));
vi.mock("@/serverFunctions/signin", () => ({
  listSignInProviders: mocks.listSignInProviders,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { Route } from "./sign-in";

const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

const STATUSES: Record<string, SignInProviderStatus> = {
  google: "on",
  github: "incomplete",
};

function listed(
  overrides: Partial<SignInProvidersListing> = {},
): SignInProvidersListing {
  const providers = SIGN_IN_PROVIDER_LIST.map(
    (provider): ListedSignInProvider => {
      const status = STATUSES[provider.id] ?? "off";
      const setNames =
        status === "on"
          ? provider.settings.map((setting) => setting.name)
          : status === "incomplete"
            ? [provider.settings[0]!.name]
            : [];
      return {
        id: provider.id,
        label: provider.label,
        status,
        missing: provider.settings
          .filter(
            (setting) => setting.required && !setNames.includes(setting.name),
          )
          .map((setting) => setting.name),
        set: setNames,
        settings: provider.settings.map((setting) => ({
          ...setting,
          set: setNames.includes(setting.name),
        })),
        callbackUrl: signInCallbackUrl("https://apps.acme.com", provider.id),
        console: provider.console,
        appNoun: provider.appNoun,
        scopes: [...provider.scopes],
        emailClaim: provider.emailClaim,
        notes: [...provider.notes],
        setup: provider.setup,
        command: `pnpm everyapp signin add ${provider.id}`,
        ...(status === "incomplete"
          ? {
              problem: `Sign in with ${provider.label} needs GITHUB_SIGNIN_CLIENT_SECRET; it is off.`,
            }
          : {}),
      };
    },
  );
  return {
    providers,
    password: { on: true, offPending: false },
    access: { on: false, label: null },
    operator: "self_hosted",
    ...overrides,
  };
}

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

async function render(listing: SignInProvidersListing = listed()) {
  mocks.listSignInProviders.mockResolvedValue(listing);
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
  mocks.listSignInProviders.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const body = () => document.body.textContent ?? "";

function rowOf(label: string): HTMLElement {
  const row = [...container.querySelectorAll("li")].find((element) =>
    element.textContent?.includes(`Continue with ${label}`),
  );
  if (!row) throw new Error(`no row for ${label}`);
  return row;
}

async function press(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

const dialog = () => document.body.querySelector('[role="dialog"]');

describe("Manage workspace → Sign-in", () => {
  it("leads with what the page is, and lists passwords and every provider with its status", async () => {
    await render();
    expect(body()).toContain(
      "People can sign in with these beside their password. Settings are Worker secrets, set from a terminal: nothing here changes them.",
    );
    expect(body()).toContain("Password");
    expect(rowOf("Google").textContent).toContain("On");
    expect(rowOf("GitHub").textContent).toContain("Needs setup");
    expect(rowOf("GitHub").textContent).toContain(
      "needs GITHUB_SIGNIN_CLIENT_SECRET",
    );
    for (const label of ["Microsoft", "Apple", "Cloudflare", "SSO"]) {
      expect(rowOf(label).textContent, label).toContain("Off");
      expect(rowOf(label).textContent, label).toContain("Set up");
    }
    // Nothing on the page changes a setting: no input, no switch.
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("opens Needs setup on the redirect URL, the settings with which are set, and the command for the operator", async () => {
    await render();
    await press(rowOf("GitHub").querySelector("button")!);
    const open = dialog()!;
    expect(open.textContent).toContain("Set up sign-in with GitHub");
    expect(open.textContent).toContain(
      "https://apps.acme.com/api/auth/callback/github",
    );
    expect(open.textContent).toContain("needs GITHUB_SIGNIN_CLIENT_SECRET");
    const settings = [...open.querySelectorAll("li")].map(
      (item) => item.textContent ?? "",
    );
    expect(
      settings.find((text) => text.includes("GITHUB_SIGNIN_CLIENT_ID")),
    ).toContain("Set");
    expect(
      settings.find((text) => text.includes("GITHUB_SIGNIN_CLIENT_SECRET")),
    ).toContain("Not set");
    expect(open.textContent).toContain("pnpm everyapp signin add github");
    expect(open.textContent).toContain("with this gateway's Cloudflare login");
    expect(open.textContent).toContain("setup/signin-github.md");
    expect(
      open.querySelector('a[href="https://github.com/settings/developers"]'),
    ).not.toBeNull();
  });

  it("asks the operator to run it on the hosted gateway, and says when passwords are off or waiting", async () => {
    await render(
      listed({
        operator: "hosted",
        password: { on: true, offPending: true },
        access: { on: true, label: "Company SSO" },
      }),
    );
    expect(body()).toContain("Cloudflare Access (Company SSO)");
    expect(body()).toContain(
      "passwords stay on until an owner has connected one of the ways below",
    );
    await press(rowOf("Apple").querySelector("button")!);
    expect(dialog()!.textContent).toContain(
      "ask the gateway's operator to run this",
    );
    expect(dialog()!.textContent).toContain("Not set");
  });

  it("shows Microsoft's optional tenant as Optional, and an on provider's details", async () => {
    await render();
    await press(rowOf("Microsoft").querySelector("button")!);
    const tenant = [...dialog()!.querySelectorAll("li")].find((item) =>
      item.textContent?.includes("MICROSOFT_SIGNIN_TENANT"),
    );
    expect(tenant?.textContent).toContain("Optional");
    await press(
      [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Close",
      )!,
    );
    expect(dialog()).toBeNull();
    await press(rowOf("Google").querySelector("button")!);
    expect(dialog()!.textContent).toContain("Sign in with Google");
    expect(dialog()!.textContent).toContain(
      "To change a setting (a new client secret)",
    );
  });

  it("explains a load failure", async () => {
    mocks.listSignInProviders.mockRejectedValue(new Error("boom"));
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
    expect(body()).toContain("Couldn't load the sign-in providers.");
  });
});
