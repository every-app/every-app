import type { LocalContext } from "@/context";
import chalk from "chalk";
import enquirer from "enquirer";
import { getGatewayPublicUrl } from "@/lib/cloudflare";
import {
  deleteGatewayCredential,
  normalizeGatewayUrl,
} from "@/lib/gateway/credentials";

async function getDefaultGatewayUrl(): Promise<string> {
  try {
    return await getGatewayPublicUrl();
  } catch {
    return "";
  }
}

export async function logout(this: LocalContext): Promise<void> {
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
  const removed = await deleteGatewayCredential(gatewayUrl);
  if (removed) {
    console.log(chalk.green(`Logged out of ${gatewayUrl}.`));
  } else {
    console.log(chalk.yellow(`No stored credential found for ${gatewayUrl}.`));
  }
}
