import enquirer from "enquirer";
import chalk from "chalk";
import {
  getAccountById,
  getMemberships,
  displayAccountInfo,
  resolveAccountFromMemberships,
  type AccountInfo,
} from "@/lib/cloudflare";

// Re-export for backwards compatibility
export { ensureWorkersDevSubdomain } from "@/lib/cloudflare";

/**
 * Get account info for the current authentication method.
 * - API token: fetches from /accounts/{id} endpoint
 * - OAuth: fetches from /memberships endpoint and handles multi-account selection
 */
async function getAccountInfo(): Promise<AccountInfo> {
  // API token auth: use /accounts/{id} endpoint (can't use /memberships)
  if (process.env["CLOUDFLARE_API_TOKEN"]) {
    const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
    if (!accountId) {
      console.log(
        chalk.yellow(
          "\nCLOUDFLARE_ACCOUNT_ID is required when using CLOUDFLARE_API_TOKEN\n",
        ),
      );
      process.exit(1);
    }
    return getAccountById(accountId);
  }

  // OAuth: use /memberships endpoint (supports multi-account selection)
  const memberships = await getMemberships();
  const { account, otherAccounts } = resolveAccountFromMemberships(memberships);
  displayAccountInfo(account, otherAccounts);
  return { id: account.account.id, name: account.account.name };
}

/**
 * Confirm deployment with the user after showing Cloudflare account info.
 * @param deployTarget - What is being deployed (e.g., "the Gateway", "this app")
 */
export async function confirmDeployment(
  deployTarget: string = "this",
): Promise<boolean> {
  const account = await getAccountInfo();

  // For API token auth, we need to display account info (OAuth already displayed it)
  if (process.env["CLOUDFLARE_API_TOKEN"]) {
    console.log(chalk.dim(`  ${account.name} (${account.id})`));
    console.log();
  }

  const { confirm } = await enquirer.prompt<{ confirm: boolean }>({
    type: "confirm",
    name: "confirm",
    message: `Do you want to deploy ${deployTarget} to ${account.name}?`,
    initial: false,
  });

  return confirm;
}
