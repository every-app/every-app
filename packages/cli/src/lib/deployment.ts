import chalk from "chalk";
import enquirer from "enquirer";
import { execa } from "execa";
import {
  getWorkersDevSubdomain,
  getDefaultAccountId,
  makeCloudflareAPIRequest,
} from "@/lib/cloudflare-auth";

interface WorkerSubdomain {
  subdomain: string;
}

/**
 * Confirm deployment with the user after showing Cloudflare account info
 */
export async function confirmDeployment(
  message: string = "Do you want to deploy to Cloudflare?",
): Promise<boolean> {
  console.log("Checking Cloudflare account...\n");

  try {
    const { stdout: accountInfo } = await execa("npx", ["wrangler", "whoami"], {
      reject: false,
    });

    // Truncate output after the account table
    const lines = accountInfo.split("\n");
    const truncatedLines: string[] = [];
    let foundTableEnd = false;

    for (const line of lines) {
      truncatedLines.push(line);
      if (line.includes("└─") && line.includes("┴─") && line.includes("┘")) {
        foundTableEnd = true;
        break;
      }
    }

    const truncatedInfo = foundTableEnd
      ? truncatedLines.join("\n")
      : accountInfo;

    console.log(chalk.dim(truncatedInfo));
    console.log();

    const response = await enquirer.prompt<{ confirm: boolean }>({
      type: "confirm",
      name: "confirm",
      message,
      initial: false,
    });

    return response.confirm;
  } catch (error) {
    console.error(
      chalk.red("\nFailed to retrieve Cloudflare account information"),
    );
    console.error(
      chalk.dim("   Make sure you're logged in with: npx wrangler login\n"),
    );
    throw error;
  }
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
