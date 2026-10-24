// @vitest-environment happy-dom
/**
 * The member row menu rendered for real (React in a DOM): which actions a
 * row offers, so the menu never shows an action the server refuses.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminUser } from "@/types/admin-user";
import { UserActionsMenu, type UserActions } from "./UserActionsMenu";

const noop = () => undefined;
const actions: UserActions = {
  onSendPasswordResetEmail: noop,
  onCreatePasswordResetLink: noop,
  onDelete: noop,
  onCopyInvitationLink: noop,
  onCancelInvitation: noop,
  onChangeRole: noop,
  onDeactivate: noop,
  onReactivate: noop,
  isPending: false,
};

function user(role: string, banned = false): AdminUser {
  return {
    id: `user-${role}`,
    name: role,
    email: `${role}@example.com`,
    role,
    status: "active",
    createdAt: new Date(),
    banned,
  };
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

function render(props: {
  user: AdminUser;
  isOwner: boolean;
  emailConfigured?: boolean;
}) {
  act(() =>
    root.render(
      <UserActionsMenu
        {...actions}
        user={props.user}
        isOwner={props.isOwner}
        emailConfigured={props.emailConfigured ?? true}
        canManageInvitations
        currentUserId="user-me"
      />,
    ),
  );
}

/** The row's kebab trigger, or null when the row offers nothing. */
function trigger(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Actions for"]',
  );
}

/** The labels of the open menu's items. */
function items(): string[] {
  act(() => {
    trigger()!.click();
  });
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("who may be sent a password reset email", () => {
  it("offers an admin the reset email for a member", () => {
    render({ user: user("member"), isOwner: false });
    expect(items()).toContain("Send password reset email");
  });

  it("offers the owner the reset email for an admin", () => {
    render({ user: user("admin"), isOwner: true });
    expect(items()).toContain("Send password reset email");
  });

  it("offers an admin nothing at all for another admin", () => {
    // The server answers OWNER_REQUIRED, so the row has no menu rather
    // than one dead-end item.
    render({ user: user("admin"), isOwner: false });
    expect(trigger()).toBeNull();
  });

  it("offers no reset email without email configured", () => {
    render({ user: user("member"), isOwner: false, emailConfigured: false });
    expect(items()).not.toContain("Send password reset email");
  });
});
