import { env } from "cloudflare:workers";
import { platformPolicy } from "@/server/platform-policy";
import { PublicError } from "./errors";

/**
 * Refuse what acts on a member's account rather than their membership
 * (deactivating or reactivating it, resetting its password) where the
 * platform policy keeps it from tenant admins: on the hosted gateway an
 * account is the person's own, whichever organizations they join.
 */
export function requireTenantAdminUserActions(): void {
  if (!platformPolicy(env).tenantAdminUserActions) {
    throw new PublicError(
      "ACCOUNT_ACTIONS_UNAVAILABLE",
      "Accounts can't be managed from an organization on this gateway",
    );
  }
}

/** Whether removing a member may also delete an account they no longer use. */
export function mayDeleteMemberAccounts(): boolean {
  return platformPolicy(env).tenantAdminUserActions;
}
