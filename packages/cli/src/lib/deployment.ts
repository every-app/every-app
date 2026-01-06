import chalk from "chalk";
import enquirer from "enquirer";
import {
  getWorkersDevSubdomain,
  getDefaultAccountId,
  makeCloudflareAPIRequest,
  type AccountInfo,
  type WorkerSubdomain,
} from "@/lib/cloudflare";

/**
 * Get account information using the Cloudflare REST API
 * GET /accounts
 */
async function getAccountInfo(): Promise<AccountInfo[]> {
  return await makeCloudflareAPIRequest<AccountInfo[]>("/accounts");
}

/**
 * Confirm deployment with the user after showing Cloudflare account info
 */
export async function confirmDeployment(
  message: string = "Do you want to deploy to Cloudflare?",
): Promise<boolean> {
  console.log("Checking Cloudflare account...\n");

  const accounts = await getAccountInfo();

  if (accounts.length === 0) {
    throw new Error("No Cloudflare accounts found");
  }

  // Display account information
  console.log(chalk.dim("  Cloudflare Accounts:"));
  for (const account of accounts) {
    console.log(chalk.dim(`    - ${account.name} (${account.id})`));
  }
  console.log();

  const response = await enquirer.prompt<{ confirm: boolean }>({
    type: "confirm",
    name: "confirm",
    message,
    initial: false,
  });

  return response.confirm;
}

/**
 * Initialize/create a workers.dev subdomain for an account
 * This needs to be done once per account before workers can be deployed
 */
async function initializeWorkersDevSubdomain(
  accountId: string,
  desiredSubdomain?: string,
): Promise<string> {
  try {
    const body = desiredSubdomain ? { subdomain: desiredSubdomain } : {};

    const result = await makeCloudflareAPIRequest<WorkerSubdomain>(
      `/accounts/${accountId}/workers/subdomain`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );

    if (!result || !result.subdomain) {
      throw new Error("Failed to initialize workers.dev subdomain");
    }

    return result.subdomain;
  } catch (error) {
    throw new Error(
      `Failed to initialize workers.dev subdomain: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Ensure workers.dev subdomain is set up, prompting user if needed
 * Returns the subdomain string
 */
export async function ensureWorkersDevSubdomain(): Promise<string> {
  const resolvedAccountId = await getDefaultAccountId();

  try {
    // Try to get existing subdomain
    const subdomain = await getWorkersDevSubdomain(resolvedAccountId);
    return subdomain;
  } catch (error) {
    // Subdomain doesn't exist, need to create one
    console.log(
      chalk.yellow("No workers.dev subdomain found for this account.\n"),
    );
    console.log(
      chalk.dim(
        "A workers.dev subdomain is required to deploy Workers applications.",
      ),
    );
    console.log(
      chalk.dim(
        "This subdomain will be used for all Workers you deploy: [worker-name].[subdomain].workers.dev\n",
      ),
    );

    const response = await enquirer.prompt<{ subdomain: string }>({
      type: "input",
      name: "subdomain",
      message: "Choose a subdomain name (alphanumeric and hyphens only):",
      validate: (value: string) => {
        if (!value || value.trim() === "") {
          return "Subdomain cannot be empty";
        }
        if (!/^[a-z0-9-]+$/.test(value)) {
          return "Subdomain must contain only lowercase letters, numbers, and hyphens";
        }
        if (value.startsWith("-") || value.endsWith("-")) {
          return "Subdomain cannot start or end with a hyphen";
        }
        return true;
      },
    });

    const desiredSubdomain = response.subdomain.trim();

    console.log(
      chalk.dim(`\nCreating workers.dev subdomain: ${desiredSubdomain}...\n`),
    );

    try {
      const subdomain = await initializeWorkersDevSubdomain(
        resolvedAccountId,
        desiredSubdomain,
      );
      console.log(
        chalk.green(
          `Successfully created subdomain: ${chalk.cyan(subdomain)}\n`,
        ),
      );
      return subdomain;
    } catch (initError) {
      console.error(
        chalk.red("\nFailed to create workers.dev subdomain"),
        chalk.dim(
          `\n   ${initError instanceof Error ? initError.message : "Unknown error"}`,
        ),
      );
      throw initError;
    }
  }
}
