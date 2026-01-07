import chalk from "chalk";
import { makeCloudflareAPIRequest } from "./auth";
import type { MembershipInfo } from "./types";

/**
 * Get all account memberships using the Cloudflare REST API
 * GET /memberships
 * This includes pending invitations, which wrangler also sees
 */
export async function getMemberships(): Promise<MembershipInfo[]> {
  return await makeCloudflareAPIRequest<MembershipInfo[]>("/memberships");
}

/**
 * Format membership status for display (e.g., " (pending)" or "")
 */
function formatMembershipStatus(membership: MembershipInfo): string {
  return membership.status === "pending" ? " (pending)" : "";
}

/**
 * Display account information to the user
 */
export function displayAccountInfo(
  accountToShow: MembershipInfo,
  otherAccounts: MembershipInfo[],
): void {
  const status = formatMembershipStatus(accountToShow);
  console.log(
    chalk.dim(
      `  ${accountToShow.account.name} (${accountToShow.account.id})${status}`,
    ),
  );

  if (otherAccounts.length > 0) {
    console.log();
    console.log(
      chalk.dim("  Other accounts (set CLOUDFLARE_ACCOUNT_ID to switch):"),
    );
    otherAccounts.forEach((membership) => {
      const otherStatus = formatMembershipStatus(membership);
      console.log(
        chalk.dim(
          `    - ${membership.account.name}: ${membership.account.id}${otherStatus}`,
        ),
      );
    });
  }

  console.log();
}

/**
 * Prompt user to select an account when multiple accounts are found.
 * Displays account selection instructions and exits.
 */
function requireAccountSelection(memberships: MembershipInfo[]): never {
  console.log(chalk.yellow("Multiple Cloudflare accounts found.\n"));
  console.log("Please set the CLOUDFLARE_ACCOUNT_ID environment variable:\n");

  memberships.forEach((membership) => {
    const status = formatMembershipStatus(membership);
    console.log(
      chalk.dim(
        `  ${membership.account.name}: ${membership.account.id}${status}`,
      ),
    );
  });

  console.log(chalk.dim("\n  export CLOUDFLARE_ACCOUNT_ID=<account_id>\n"));
  process.exit(1);
}

/**
 * Find the account to use from memberships.
 * If CLOUDFLARE_ACCOUNT_ID is set, find that account.
 * If there's only one account, use it.
 * If there are multiple accounts and no selection, throw UserFacingError.
 */
export function resolveAccountFromMemberships(memberships: MembershipInfo[]): {
  account: MembershipInfo;
  otherAccounts: MembershipInfo[];
} {
  if (memberships.length === 0) {
    throw new Error("No Cloudflare accounts found");
  }

  const selectedAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"];

  // Check if user has multiple accounts/memberships and no account ID set
  if (!selectedAccountId && memberships.length > 1) {
    requireAccountSelection(memberships);
  }

  // Find the account to show - selected account or the single account
  const account = selectedAccountId
    ? memberships.find((m) => m.account.id === selectedAccountId)
    : memberships[0];

  if (!account) {
    throw new Error(
      `Account ${selectedAccountId} not found in your Cloudflare memberships`,
    );
  }

  const otherAccounts = memberships.filter(
    (m) => m.account.id !== account.account.id,
  );

  return { account, otherAccounts };
}
