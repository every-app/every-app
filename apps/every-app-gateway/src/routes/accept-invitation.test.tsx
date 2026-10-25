// @vitest-environment happy-dom
/**
 * The accept page rendered for real (React in a DOM) with the gateway's
 * answers mocked: which card each pair of (session, link lookup) gets, and
 * that a dead lookup ends the page only for someone signed out. Signed in,
 * the server decides on Join: behind the Access outer ring the session
 * check itself accepts the invitation, after which the lookup says 404
 * while the link still confirms (access-sign-in.sqlite.test.ts).
 */
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "@/client/tanstack-db/queryClient";

const search = vi.hoisted(() => ({ current: {} as { token?: string } }));
const session = vi.hoisted(() => ({
  current: { isPending: false, data: null } as {
    isPending: boolean;
    data: { user: { email: string } } | null;
  },
}));
const lookupInvitation = vi.hoisted(() => vi.fn());
const acceptInvitation = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>): unknown => ({
      options,
      useSearch: () => search.current,
    }),
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children?: ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/client/hooks/useSession", () => ({
  useSession: () => session.current,
}));
vi.mock("@/client/invitation-link", () => ({ lookupInvitation }));
vi.mock("@/serverFunctions/organizations", () => ({ acceptInvitation }));
vi.mock("@/client/tanstack-db", () => ({
  refetchCollectionsAfterAuth: vi.fn(),
}));
vi.mock("@/client/auth-client", () => ({ isCpuTimeoutError: () => false }));

import { Route } from "./accept-invitation";

const Page = Route.options.component as ComponentType;
const LIVE = {
  organizationName: "Acme Corp",
  invitedEmail: "b•••@partner.example",
};
const BOB = { user: { email: "bob@partner.example" } };

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  queryClient.clear();
  lookupInvitation.mockReset();
  acceptInvitation.mockReset();
  search.current = { token: "einv_test-token" };
  session.current = { isPending: false, data: null };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Let the lookup and any click settle. */
async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function text(): string {
  return container.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`no button "${label}" in: ${text()}`);
  return match;
}

it("signed out, a dead link ends the page before any account is made", async () => {
  lookupInvitation.mockResolvedValue(null);
  await render();
  expect(text()).toContain("Invitation link not valid");
  expect(text()).not.toContain("Sign in or create an account");
  expect(container.querySelector('a[href="/sign-in"]')).not.toBeNull();
});

it("signed out, a live link names the organization and the masked address", async () => {
  lookupInvitation.mockResolvedValue(LIVE);
  await render();
  expect(text()).toContain("You're invited to Acme Corp");
  expect(text()).toContain(
    "Sign in or create an account as b•••@partner.example to accept.",
  );
  expect(container.querySelector('a[href="/sign-up"]')).not.toBeNull();

  // Back from /sign-in (a client-side navigate remounts the page): one
  // lookup per token, whatever the shared client's refetch-on-mount says.
  act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(lookupInvitation).toHaveBeenCalledOnce();
});

it("signed in, a dead lookup still offers Join and lets the server confirm the link", async () => {
  // Access accepted the invitation at the door: no longer pending, so the
  // lookup says 404, and the link's own accept only confirms it.
  lookupInvitation.mockResolvedValue(null);
  acceptInvitation.mockResolvedValue({ organizationId: "org-acme" });
  session.current = { isPending: false, data: BOB };
  await render();
  expect(text()).not.toContain("Invitation link not valid");
  expect(text()).toContain("Accept invitation");
  expect(text()).toContain("Signed in as bob@partner.example");

  await act(async () => button("Join organization").click());
  await flush();
  expect(acceptInvitation).toHaveBeenCalledExactlyOnceWith({
    data: { token: "einv_test-token" },
  });
  expect(text()).toContain("Invitation accepted");
});

it("signed in, a truly dead token surfaces as the alert on Join", async () => {
  lookupInvitation.mockResolvedValue(null);
  acceptInvitation.mockRejectedValue(
    new Error("This invitation link is invalid, expired or already used."),
  );
  session.current = { isPending: false, data: BOB };
  await render();

  await act(async () => button("Join organization").click());
  await flush();
  expect(text()).toContain(
    "This invitation link is invalid, expired or already used.",
  );
  expect(text()).not.toContain("Invitation link not valid");
});

it("signed in, a live link says which organization Join is for", async () => {
  lookupInvitation.mockResolvedValue(LIVE);
  session.current = { isPending: false, data: BOB };
  await render();
  expect(text()).toContain("Join Acme Corp");
  expect(text()).toContain("Signed in as bob@partner.example");
  button("Join organization");
});

it("without a token the page is not valid, and asks the gateway nothing", async () => {
  search.current = {};
  await render();
  expect(text()).toContain("Invitation link not valid");
  expect(lookupInvitation).not.toHaveBeenCalled();
});
