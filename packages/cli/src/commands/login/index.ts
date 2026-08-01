import type { LocalContext } from "@/context";
import chalk from "chalk";
import enquirer from "enquirer";
import { getGatewayPublicUrl } from "@/lib/cloudflare";
import { GatewayClient } from "@/lib/gateway/api";
import {
  normalizeGatewayUrl,
  writeGatewayCredential,
} from "@/lib/gateway/credentials";

async function getDefaultGatewayUrl(): Promise<string> {
  try {
    return await getGatewayPublicUrl();
  } catch {
    return "";
  }
}

export async function login(this: LocalContext): Promise<void> {
  const defaultGatewayUrl = await getDefaultGatewayUrl();
  const { gatewayUrl: rawGatewayUrl } = await enquirer.prompt<{
    gatewayUrl: string;
  }>({
    type: "input",
    name: "gatewayUrl",
    message: "Gateway URL",
    initial: defaultGatewayUrl,
    validate: (value: string) => {
      try {
        normalizeGatewayUrl(value.trim());
        return true;
      } catch {
        return "Enter a valid gateway URL";
      }
    },
  });

  const gatewayUrl = normalizeGatewayUrl(rawGatewayUrl.trim());
  const { token } = await enquirer.prompt<{ token: string }>({
    type: "password",
    name: "token",
    message: "Deploy token",
    validate: (value: string) => {
      if (!value.trim().startsWith("eak_")) {
        return "Deploy tokens start with eak_";
      }

      return true;
    },
  });

  const client = new GatewayClient({
    gatewayUrl,
    getAuthToken: async () => token.trim(),
  });
  const whoami = await client.whoami();

  await writeGatewayCredential({
    gatewayUrl,
    token: token.trim(),
    organizationId: whoami.organizationId,
  });

  console.log(
    chalk.green(
      `Logged in to ${gatewayUrl} for ${whoami.organizationName} (${whoami.organizationId}).`,
    ),
  );
}
