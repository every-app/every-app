import chalk from "chalk";
import enquirer from "enquirer";
import { getValidCloudflareToken } from "@/lib/cloudflare";
import { resolveOrganizationIdForGateway } from "@/lib/gateway-org";
import { exitWithUpdateNotice } from "@/lib/version-check";

interface InsertUserAppOptions {
  appId: string;
  appUrl: string;
  gatewayUrl: string;
  verbose?: boolean;
  appName?: string;
  appDescription?: string;
  devUrl?: string;
}

interface GatewayUser {
  id: string;
  name: string;
  email: string;
}

interface GatewayErrorPayload {
  error?: string;
}

type AccessMode = "all" | "select" | "none";

const GATEWAY_INTERNAL_API_TIMEOUT_MS = 15_000;
const OUTDATED_GATEWAY_ERROR = "OUTDATED_GATEWAY";
const GATEWAY_INTERNAL_AUTH_ERROR = "GATEWAY_INTERNAL_AUTH";

async function callGatewayInternalApi<T>(
  gatewayUrl: string,
  path: string,
  cloudflareToken: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(GATEWAY_INTERNAL_API_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${cloudflareToken}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 404) {
    throw new Error(OUTDATED_GATEWAY_ERROR);
  }

  let payload: GatewayErrorPayload & T;
  try {
    payload = (await response.json()) as GatewayErrorPayload & T;
  } catch {
    if (!response.ok) {
      throw new Error(`Gateway request failed (${response.status})`);
    }

    throw new Error("Gateway returned an invalid JSON response");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(GATEWAY_INTERNAL_AUTH_ERROR);
    }

    throw new Error(
      payload.error || `Gateway request failed (${response.status})`,
    );
  }

  return payload;
}

export async function insertUserAppRecords(
  options: InsertUserAppOptions,
): Promise<{ organizationId: string }> {
  const {
    appId,
    appUrl,
    gatewayUrl,
    verbose = false,
    appName,
    appDescription,
    devUrl,
  } = options;

  try {
    console.log("");
    if (verbose) {
      console.log("Registering app with gateway control plane...");
    }

    const cloudflareToken = await getValidCloudflareToken();
    const organizationId = await resolveOrganizationIdForGateway({
      verbose,
      gatewayUrl,
      cloudflareToken,
    });

    const displayName = appName || appId;
    const displayDescription = appDescription || appId;

    const registrationState = await callGatewayInternalApi<{
      existingApp: boolean;
      defaultAccess: boolean;
    }>(
      gatewayUrl,
      `/api/internal/apps/register?organizationId=${encodeURIComponent(organizationId)}&appId=${encodeURIComponent(appId)}`,
      cloudflareToken,
      "GET",
    );

    if (registrationState.existingApp && verbose) {
      console.log(
        chalk.dim(
          "App already configured in gateway. Skipping access prompts.",
        ),
      );
    }

    const defaultAccess = registrationState.existingApp
      ? registrationState.defaultAccess
      : await promptForDefaultAccess(
          "Add future users by default to this app?",
        );

    let accessMode: AccessMode = "none";
    let selectedUserIds: string[] = [];

    if (!registrationState.existingApp) {
      const usersResponse = await callGatewayInternalApi<{
        users: GatewayUser[];
      }>(
        gatewayUrl,
        `/api/internal/apps/users?organizationId=${encodeURIComponent(organizationId)}`,
        cloudflareToken,
        "GET",
      );

      const users = usersResponse.users;

      if (users.length > 0) {
        accessMode = await promptForAccessMode();
      }

      if (accessMode === "all") {
        selectedUserIds = users.map((user) => user.id);
      } else if (accessMode === "select") {
        selectedUserIds = await promptForUserSelection(users);
      }
    }

    const registerResponse = await callGatewayInternalApi<{
      appId: string;
      appSlug: string;
      existingApp: boolean;
      defaultAccess: boolean;
      grantedUserCount: number;
    }>(gatewayUrl, "/api/internal/apps/register", cloudflareToken, "POST", {
      appId,
      organizationId,
      appUrl,
      name: displayName,
      description: displayDescription,
      devUrl,
      isDefault: defaultAccess,
      accessMode,
      selectedUserIds,
    });

    if (verbose) {
      console.log(
        chalk.dim(
          `  Gateway app: ${registerResponse.appSlug} (${registerResponse.existingApp ? "updated" : "created"})`,
        ),
      );
      console.log(
        chalk.dim(
          `  Default access: ${registerResponse.defaultAccess ? "enabled" : "disabled"}`,
        ),
      );
      console.log(
        chalk.dim(
          `  Access granted to ${registerResponse.grantedUserCount} users\n`,
        ),
      );
    }

    return { organizationId };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === OUTDATED_GATEWAY_ERROR
    ) {
      console.log(chalk.yellow("\nGateway out of date\n"));
      console.log(
        chalk.dim("  Run: `npx everyapp gateway deploy` to update.\n"),
      );
      await exitWithUpdateNotice(1);
    }

    if (
      error instanceof Error &&
      error.message === GATEWAY_INTERNAL_AUTH_ERROR
    ) {
      console.log(chalk.yellow("\nGateway authorization failed\n"));
      console.log(
        chalk.dim(
          "  Your Cloudflare token must access the same account as the gateway and allow Workers + D1 APIs.",
        ),
      );
      console.log(
        chalk.dim(
          "  Re-run `npx everyapp gateway deploy` if this gateway was deployed with older auth checks.\n",
        ),
      );
      await exitWithUpdateNotice(1);
    }

    console.error(
      chalk.red("\nFailed to insert UserApp records"),
      error instanceof Error ? `\n   ${error.message}\n` : "",
    );
    throw error;
  }
}

async function promptForDefaultAccess(message: string): Promise<boolean> {
  const { confirm } = await enquirer.prompt<{ confirm: boolean }>({
    type: "confirm",
    name: "confirm",
    message,
    initial: true,
  });

  return confirm;
}

async function promptForAccessMode(): Promise<AccessMode> {
  const { mode } = await enquirer.prompt<{ mode: AccessMode }>({
    type: "select",
    name: "mode",
    message: "Add existing users now?",
    choices: [
      { name: "all", message: "All users" },
      { name: "select", message: "Select users" },
      { name: "none", message: "None" },
    ],
    initial: 0,
  });

  return mode;
}

async function promptForUserSelection(
  users: GatewayUser[],
): Promise<string[]> {
  const { selected } = await enquirer.prompt<{ selected: string[] }>({
    type: "multiselect",
    name: "selected",
    message: "Select users to grant access",
    choices: users.map((user) => ({
      name: user.id,
      message: formatUserLabel(user),
    })),
  });

  return selected;
}

function formatUserLabel(user: GatewayUser): string {
  if (user.name && user.name.trim()) {
    return `${user.name} <${user.email}>`;
  }

  return user.email;
}
