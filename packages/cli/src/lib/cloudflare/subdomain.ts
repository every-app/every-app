import chalk from "chalk";
import enquirer from "enquirer";
import { makeCloudflareAPIRequest } from "./auth";
import { getDefaultAccountId, getWorkersDevSubdomain } from "./auth";
import type { WorkerSubdomain } from "./types";

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
 * Prompt user for a subdomain name with validation
 */
async function promptForSubdomain(): Promise<string> {
  const response = await enquirer.prompt<{ subdomain: string }>({
    type: "input",
    name: "subdomain",
    message: "  Choose a subdomain name:",
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

  return response.subdomain.trim();
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
  } catch {
    // Subdomain doesn't exist, need to create one
    console.log();
    console.log(chalk.yellow("  Please claim a Cloudflare subdomain.\n"));
    console.log(
      chalk.dim("  All your apps will be deployed to this domain.\n"),
    );
    console.log(chalk.dim("  You can make it your name or a something fun."));
    console.log(
      chalk.dim('  E.g. All apps will be deployed to "janedoe.workers.dev"\n'),
    );

    const desiredSubdomain = await promptForSubdomain();

    console.log(chalk.dim(`\n  Creating subdomain: ${desiredSubdomain}...\n`));

    try {
      const subdomain = await initializeWorkersDevSubdomain(
        resolvedAccountId,
        desiredSubdomain,
      );
      console.log(
        chalk.green(
          `  Successfully created subdomain: ${chalk.cyan(subdomain)}\n`,
        ),
      );
      return subdomain;
    } catch (initError) {
      console.error(
        chalk.red("\n  Failed to create subdomain"),
        chalk.dim(
          `\n  ${initError instanceof Error ? initError.message : "Unknown error"}`,
        ),
      );
      throw initError;
    }
  }
}
