import chalk from "chalk";
import { getDefaultAccountId } from "./auth";

/**
 * Known Cloudflare error codes and their user-friendly messages
 */
const CLOUDFLARE_ERROR_CODES = {
  EMAIL_NOT_VERIFIED: 10034,
  R2_NOT_ENABLED: 10042,
} as const;

interface CloudflareErrorInfo {
  code: number;
  userMessage: string;
  action: string;
}

/**
 * Known Cloudflare errors with user-friendly messages and actions
 * The action field supports a {accountId} placeholder that will be replaced at runtime
 */
const KNOWN_ERRORS: Record<number, Omit<CloudflareErrorInfo, "code">> = {
  [CLOUDFLARE_ERROR_CODES.EMAIL_NOT_VERIFIED]: {
    userMessage:
      "Almost there! Your Cloudflare account email needs to be verified first.",
    action: `To verify your email address:

  1. Check your inbox for a verification email from Cloudflare
  2. Click the verification link in the email
  3. Or visit ${chalk.cyan("https://dash.cloudflare.com/profile")} to resend the verification email

Then run this command again.`,
  },
  [CLOUDFLARE_ERROR_CODES.R2_NOT_ENABLED]: {
    userMessage: "R2 not enabled",
    action: `R2 is Cloudflare's file storage service, used for storing images and files.

  ${chalk.cyan("https://dash.cloudflare.com/{accountId}/r2/plans")}

${chalk.dim("  Visit the URL above to enable R2, then run this command again.")}`,
  },
};

/**
 * Parse error output from wrangler or Cloudflare API to extract error code
 */
function parseCloudflareErrorCode(errorOutput: string): number | undefined {
  // Match patterns like [code: 10034] or "code":10034 or [10042]
  const codeMatch = errorOutput.match(/\[code:\s*(\d+)\]/);
  if (codeMatch?.[1]) {
    return parseInt(codeMatch[1], 10);
  }

  const jsonCodeMatch = errorOutput.match(/"code"\s*:\s*(\d+)/);
  if (jsonCodeMatch?.[1]) {
    return parseInt(jsonCodeMatch[1], 10);
  }

  // Match standalone error code in brackets like [10042]
  const bracketCodeMatch = errorOutput.match(/\[(\d{5})\]/);
  if (bracketCodeMatch?.[1]) {
    return parseInt(bracketCodeMatch[1], 10);
  }

  return undefined;
}

/**
 * Get user-friendly error info for a Cloudflare error code
 */
function getCloudflareErrorInfo(code: number): CloudflareErrorInfo | undefined {
  const errorInfo = KNOWN_ERRORS[code];
  if (errorInfo) {
    return { code, ...errorInfo };
  }
  return undefined;
}

/**
 * Extract error output string from various error types
 */
function getErrorOutput(error: unknown): string {
  let errorOutput = "";

  if (error instanceof Error) {
    errorOutput = error.message;
    // execa errors have stdout/stderr properties
    if ("stdout" in error && typeof error.stdout === "string") {
      errorOutput += "\n" + error.stdout;
    }
    if ("stderr" in error && typeof error.stderr === "string") {
      errorOutput += "\n" + error.stderr;
    }
    // execa also has 'all' which combines stdout and stderr
    if ("all" in error && typeof error.all === "string") {
      errorOutput += "\n" + error.all;
    }
  } else if (typeof error === "string") {
    errorOutput = error;
  }

  return errorOutput;
}

interface FormatCloudflareErrorOptions {
  /** Account ID to substitute in error messages (e.g., for R2 links) */
  accountId?: string;
}

interface FormatCloudflareErrorResult {
  formatted: string;
  code: number;
}

/**
 * Build a formatted error message from a Cloudflare error code
 */
async function buildFormattedMessage(
  errorInfo: CloudflareErrorInfo,
  options: FormatCloudflareErrorOptions,
): Promise<string> {
  // Replace placeholders in action text
  let action = errorInfo.action;

  // Try to get accountId from options, or fall back to fetching it
  let accountId = options.accountId;
  if (!accountId && action.includes("{accountId}")) {
    try {
      accountId = await getDefaultAccountId();
    } catch {
      // If we can't get the account ID, leave the placeholder
    }
  }
  if (accountId) {
    action = action.replace(/{accountId}/g, accountId);
  }

  return `
${chalk.yellow(errorInfo.userMessage)}

${action}
`;
}

/**
 * Check if an error is a known Cloudflare error and return formatted message
 * Returns undefined if the error is not a known Cloudflare error
 */
export async function formatCloudflareError(
  error: unknown,
  options: FormatCloudflareErrorOptions = {},
): Promise<FormatCloudflareErrorResult | undefined> {
  const errorOutput = getErrorOutput(error);

  const code = parseCloudflareErrorCode(errorOutput);
  if (code === undefined) {
    return undefined;
  }

  const errorInfo = getCloudflareErrorInfo(code);
  if (!errorInfo) {
    return undefined;
  }

  const formatted = await buildFormattedMessage(errorInfo, options);
  return { formatted, code };
}
