// @vitest-environment happy-dom
/**
 * The Manage access dialog rendered for real: what it says and what it
 * saves when a group grants someone the app, the admin included.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppWithAccessCount, UserAccessState } from "@/types/app";

const mocks = vi.hoisted(() => ({
  currentUserId: "admin",
  users: [] as UserAccessState[],
  updateAppAccess: vi.fn(async () => ({ granted: 0, revoked: 0 })),
  refetch: vi.fn(async () => undefined),
}));
vi.mock("@/client/hooks/useSession", () => ({
  useSession: () => ({ data: { user: { id: mocks.currentUserId } } }),
}));
vi.mock("@/serverFunctions/apps", () => ({
  getAppAccessState: async () => ({ users: mocks.users }),
  updateAppAccess: mocks.updateAppAccess,
}));
vi.mock("@/client/tanstack-db", () => ({
  adminAppsCollection: { utils: { refetch: mocks.refetch } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ManageAppAccessModal } from "./ManageAppAccessModal";

const APP = {
  id: "app-notes",
  name: "Notes",
} as AppWithAccessCount;

function user(
  id: string,
  state: Partial<Pick<UserAccessState, "hasAccess" | "viaGroups">> = {},
): UserAccessState {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    email: `${id}@example.com`,
    role: "member",
    status: "active",
    hasAccess: false,
    viaGroups: [],
    ...state,
  };
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

async function render(users: UserAccessState[], app: AppWithAccessCount = APP) {
  mocks.users = users;
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ManageAppAccessModal app={app} onClose={() => undefined} />
      </QueryClientProvider>,
    ),
  );
  // The access state loads.
  for (let tick = 0; tick < 10; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    if (document.body.textContent?.includes("will have access")) return;
  }
  throw new Error("the dialog never loaded its users");
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** The list row naming a user. */
function row(name: string): HTMLElement {
  const found = [...document.body.querySelectorAll("li")].find((element) =>
    element.textContent?.includes(name),
  );
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

/**
 * The row's checkbox: the `role="checkbox"` element that shows its state,
 * and the input a label click toggles (in happy-dom a click on the element
 * itself bubbles to the label and toggles twice).
 */
function checkbox(name: string): HTMLElement {
  return row(name).querySelector<HTMLElement>('[role="checkbox"]')!;
}

function checkboxInput(name: string): HTMLInputElement {
  return row(name).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function checkboxState(name: string): { checked: boolean; disabled: boolean } {
  const element = checkbox(name);
  return {
    checked: element.getAttribute("aria-checked") === "true",
    disabled: element.getAttribute("aria-disabled") === "true",
  };
}

function footer(): string {
  return (
    /(\d+ of \d+ users? will have access(?: \(\d+ through groups\))?)/.exec(
      document.body.textContent ?? "",
    )?.[1] ?? ""
  );
}

async function press(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

async function save(): Promise<string[]> {
  await press(button("Save changes"));
  for (let tick = 0; tick < 10; tick++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    if (mocks.updateAppAccess.mock.calls.length) break;
  }
  const [call] = mocks.updateAppAccess.mock.calls as unknown as [
    { data: { appId: string; userIds: string[] } },
  ][];
  expect(call?.[0].data.appId).toBe(APP.id);
  return [...call![0].data.userIds].sort();
}

beforeEach(() => {
  mocks.updateAppAccess.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Revoke all", () => {
  it("keeps the admin's own direct grant and nobody else's", async () => {
    await render([
      user("admin", { hasAccess: true }),
      user("alice", { hasAccess: true }),
      user("bob"),
    ]);
    expect(footer()).toBe("2 of 3 users will have access");

    await press(button("Revoke all"));
    expect(footer()).toBe("1 of 3 users will have access");
    expect(row("Alice").textContent).toContain("Revoking");
    expect(await save()).toEqual(["admin"]);
  });

  it("never gives an admin a group lets in a direct grant", async () => {
    await render([
      user("admin", { viaGroups: ["Sales"] }),
      user("alice", { hasAccess: true }),
    ]);
    expect(footer()).toBe("2 of 2 users will have access (1 through groups)");
    expect(checkboxState("Admin")).toEqual({ checked: true, disabled: true });

    await press(button("Revoke all"));
    // The admin stays in through Sales, once, and is not granted directly.
    expect(footer()).toBe("1 of 2 users will have access (1 through groups)");
    expect(await save()).toEqual([]);
  });
});

describe("a user granted directly and through a group", () => {
  it("keeps access when the direct grant is unchecked, and says so", async () => {
    await render([
      user("admin", { hasAccess: true }),
      user("owner", { hasAccess: true, viaGroups: ["Sales"] }),
      user("bob"),
    ]);
    expect(footer()).toBe("2 of 3 users will have access");
    expect(row("Owner").textContent).toContain("via Sales");
    expect(checkboxState("Owner")).toEqual({ checked: true, disabled: false });

    await press(checkboxInput("Owner"));
    const owner = row("Owner");
    expect(checkboxState("Owner")).toEqual({ checked: false, disabled: false });
    expect(owner.textContent).toContain("Direct grant removed");
    expect(owner.textContent).not.toContain("Revoking");
    expect(owner.querySelector("label")?.className).not.toContain(
      "bg-destructive",
    );
    expect(document.body.textContent).toContain("1 kept through groups");
    expect(document.body.textContent).not.toContain("losing access");
    expect(footer()).toBe("2 of 3 users will have access (1 through groups)");
    expect(await save()).toEqual(["admin"]);
  });
});

describe("an app available to everyone", () => {
  const LINE =
    "Available to everyone: people who join later get access too. Unchecking someone here takes theirs away.";

  it("says the flag is an auto-grant, and unchecking still revokes", async () => {
    await render(
      [user("admin", { hasAccess: true }), user("alice", { hasAccess: true })],
      { ...APP, isDefault: true },
    );
    // The dialog's description, so it is announced on open.
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const description = document.getElementById(
      dialog.getAttribute("aria-describedby") ?? "",
    );
    expect(description?.textContent).toBe(LINE);

    // The grants stay the truth: the flag bypasses nothing.
    await press(checkboxInput("Alice"));
    expect(row("Alice").textContent).toContain("Revoking");
    expect(footer()).toBe("1 of 2 users will have access");
    expect(await save()).toEqual(["admin"]);
  });

  it("says nothing of the flag when it is off", async () => {
    await render([user("admin", { hasAccess: true })]);
    expect(document.body.textContent).not.toContain("Available to everyone");
  });
});
