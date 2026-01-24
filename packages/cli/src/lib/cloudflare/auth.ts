// This code was inspired by the wrangler cli implementation: https://github.com/cloudflare/workers-sdk/blob/90a2566982637ceb362e3cdbd7c433b5b4de9b28/packages/wrangler/src/user/user.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as TOML from "smol-toml";
import chalk from "chalk";
import type { AccountInfo, WorkerSubdomain } from "./types";
import { exitWithUpdateNotice } from "@/lib/version-check";

interface OAuthToken {
  oauth_token: string;
  expiration_time: string;
  refresh_token: string;
  scopes: string[];
}

interface CloudflareAPIResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
}

/**
 * Get the path to the wrangler config directory
 * Based on wrangler's implementation for cross-platform support
 */
function getWranglerOAuthConfigPath(): string {
  const homeDir = os.homedir();
  const platform = os.platform();

  let configDir: string;

  if (platform === "win32") {
    // Windows: %LOCALAPPDATA%\.wrangler
    configDir = path.join(
      process.env["LOCALAPPDATA"] || path.join(homeDir, "AppData", "Local"),
      ".wrangler",
    );
  } else if (platform === "darwin") {
    // macOS: ~/Library/Preferences/.wrangler
    configDir = path.join(homeDir, "Library", "Preferences", ".wrangler");
  } else {
    // Linux/Unix: ~/.wrangler
    configDir = path.join(homeDir, ".wrangler");
  }

  return path.join(configDir, "config", "default.toml");
}

/**
 * Read OAuth token from wrangler config
 */
async function readOAuthToken(): Promise<OAuthToken> {
  const configPath = getWranglerOAuthConfigPath();

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = TOML.parse(content) as unknown as OAuthToken;

    if (!config.oauth_token || !config.refresh_token) {
      throw new Error("OAuth tokens not found in wrangler config");
    }

    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "Wrangler config not found. Please run 'npx wrangler login' first.",
      );
    }
    throw error;
  }
}

/**
 * Write OAuth token to wrangler config.
 * Matches wrangler's writeAuthConfigFile behavior - overwrites with OAuth fields only.
 * See: https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/user/user.ts
 */
async function writeOAuthToken(token: OAuthToken): Promise<void> {
  const configPath = getWranglerOAuthConfigPath();

  // Ensure directory exists
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });

  const content = TOML.stringify(token as unknown as Record<string, unknown>);
  await fs.writeFile(configPath, content, "utf-8");
}

/**
 * Check if the OAuth token is expired or about to expire (within 5 minutes)
 */
function isTokenExpired(expirationTime: string): boolean {
  const expiresAt = new Date(expirationTime).getTime();
  const now = Date.now();
  const oneMinute = 1 * 60 * 1000;

  return expiresAt - now < oneMinute;
}

/**
 * Refresh the OAuth token using the refresh token
 */
async function refreshOAuthToken(refreshToken: string): Promise<OAuthToken> {
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "54d11594-84e4-41aa-b438-e81b8fa78ee7",
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to refresh OAuth token: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as any;

  const newToken: OAuthToken = {
    oauth_token: data.access_token,
    expiration_time: new Date(
      Date.now() + data.expires_in * 1000,
    ).toISOString(),
    refresh_token: data.refresh_token || refreshToken,
    scopes: data.scope ? data.scope.split(" ") : [],
  };

  return newToken;
}

interface RequireCloudflareAuthOptions {
  /** Show extended help for users who don't have a Cloudflare account yet */
  showNewUserHelp?: boolean;
}

/**
 * Require Cloudflare authentication to be available.
 * Exits the process with a helpful error message if not authenticated.
 *
 * Auth precedence:
 * 1. If CLOUDFLARE_API_TOKEN is set, it will be used (requires CLOUDFLARE_ACCOUNT_ID)
 * 2. Otherwise, fall back to wrangler OAuth
 */
export async function requireCloudflareAuth(
  options: RequireCloudflareAuthOptions = {},
): Promise<void> {
  const { showNewUserHelp = false } = options;
  const hasApiToken = !!process.env["CLOUDFLARE_API_TOKEN"];
  const hasAccountId = !!process.env["CLOUDFLARE_ACCOUNT_ID"];

  // API token takes precedence - if set, require account ID regardless of OAuth
  if (hasApiToken && !hasAccountId) {
    console.log(chalk.yellow("\nMissing CLOUDFLARE_ACCOUNT_ID\n"));
    console.log(
      "When using CLOUDFLARE_API_TOKEN, you must also set CLOUDFLARE_ACCOUNT_ID.\n",
    );
    console.log(
      chalk.dim("  export CLOUDFLARE_ACCOUNT_ID=<your_account_id>\n"),
    );
    await exitWithUpdateNotice(1);
  }

  // API token auth is fully configured
  if (hasApiToken && hasAccountId) {
    return;
  }

  // Try OAuth - actually validate it works, not just that file exists
  try {
    await getValidCloudflareToken();
  } catch {
    if (showNewUserHelp) {
      console.log(chalk.yellow("\nAlready have a Cloudflare account?\n"));
    } else {
      console.log(chalk.yellow("\nPlease log in to Cloudflare.\n"));
    }
    console.log(
      chalk.dim("  1. Cloudflare CLI (recommended): npx wrangler login"),
    );
    console.log(
      chalk.dim(
        "  2. Environment variables: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID\n",
      ),
    );

    if (showNewUserHelp) {
      console.log(chalk.yellow("Don't have a Cloudflare account?\n"));
      console.log(
        "Every App uses Cloudflare so that you can inexpensively host your applications",
      );
      console.log(
        "on a secure and powerful platform without needing to think about the machines",
      );
      console.log("your code runs on.\n");
      console.log("Here are the steps to get started:\n");
      console.log(
        chalk.dim(
          "  1. Create a Cloudflare account (free, no credit card required):",
        ),
      );
      console.log(chalk.cyan("     https://dash.cloudflare.com/sign-up\n"));
      console.log(
        chalk.dim(
          "     - Skip any Cloudflare onboarding like configuring a domain, this is unnecessary for Every App.\n",
        ),
      );
      console.log(
        chalk.dim("  2. Check your email to verify your email address\n"),
      );
      console.log(chalk.dim("  3. Log in to Cloudflare via the CLI:"));
      console.log(chalk.cyan("     npx wrangler login\n"));
      console.log(
        chalk.dim("     - Learn more: ") +
          chalk.cyan(
            "https://developers.cloudflare.com/workers/wrangler/commands/#login\n",
          ),
      );
    }

    await exitWithUpdateNotice(1);
  }
}

/**
 * Get a valid Cloudflare API token.
 * If CLOUDFLARE_API_TOKEN is set in the environment, use it directly.
 * Otherwise, fall back to OAuth token from wrangler config (refreshing if necessary).
 */
export async function getValidCloudflareToken(): Promise<string> {
  // Check for API token in environment first
  const envToken = process.env["CLOUDFLARE_API_TOKEN"];
  if (envToken) {
    return envToken;
  }

  // Fall back to OAuth token from wrangler config
  const token = await readOAuthToken();

  if (isTokenExpired(token.expiration_time)) {
    const refreshedToken = await refreshOAuthToken(token.refresh_token);
    await writeOAuthToken(refreshedToken);
    return refreshedToken.oauth_token;
  }

  return token.oauth_token;
}

/**
 * Make an authenticated request to the Cloudflare API
 */
export async function makeCloudflareAPIRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const accessToken = await getValidCloudflareToken();

  const response = await fetch(
    `https://api.cloudflare.com/client/v4${endpoint}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    },
  );

  const data = (await response.json()) as CloudflareAPIResponse<T>;

  if (!response.ok) {
    const errorDetails = data.errors
      ? data.errors.map((e) => `[${e.code}] ${e.message}`).join(", ")
      : response.statusText;
    throw new Error(
      `Cloudflare API request failed: ${response.status} ${errorDetails}`,
    );
  }

  if (!data.success) {
    const errorMessage = data.errors
      .map((e) => `[${e.code}] ${e.message}`)
      .join(", ");
    throw new Error(`Cloudflare API error: ${errorMessage}`);
  }

  return data.result;
}

/**
 * Get the default Cloudflare account ID.
 * If CLOUDFLARE_ACCOUNT_ID is set in the environment, use it directly.
 * Otherwise, fetch accounts from API and return the first one.
 */
export async function getDefaultAccountId(): Promise<string> {
  // Check for account ID in environment first
  const envAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (envAccountId) {
    return envAccountId;
  }

  // Fall back to fetching from API
  const accounts = await makeCloudflareAPIRequest<AccountInfo[]>("/accounts");

  if (!accounts || accounts.length === 0) {
    throw new Error("No Cloudflare accounts found");
  }

  const firstAccount = accounts[0];
  if (!firstAccount) {
    throw new Error("No Cloudflare accounts found");
  }

  // Return the first account ID (typically the default)
  return firstAccount.id;
}

/**
 * Get account details by ID.
 * Uses GET /accounts/{account_id} endpoint which works with both OAuth and API tokens.
 */
export async function getAccountById(accountId: string): Promise<AccountInfo> {
  const result = await makeCloudflareAPIRequest<AccountInfo>(
    `/accounts/${accountId}`,
  );

  if (!result || !result.id) {
    throw new Error(`Account ${accountId} not found`);
  }

  return result;
}

/**
 * Get the workers.dev subdomain for an account
 */
export async function getWorkersDevSubdomain(
  accountId: string,
): Promise<string> {
  try {
    const result = await makeCloudflareAPIRequest<WorkerSubdomain>(
      `/accounts/${accountId}/workers/subdomain`,
    );

    if (!result || !result.subdomain) {
      throw new Error("No workers.dev subdomain found for this account");
    }

    return result.subdomain;
  } catch (error) {
    throw new Error(
      `Failed to get workers.dev subdomain: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Get the full workers.dev URL for a worker
 */
export async function getWorkerUrl(
  workerName: string,
  accountId?: string,
): Promise<string> {
  const resolvedAccountId = accountId || (await getDefaultAccountId());
  const subdomain = await getWorkersDevSubdomain(resolvedAccountId);
  return `https://${workerName}.${subdomain}.workers.dev`;
}
