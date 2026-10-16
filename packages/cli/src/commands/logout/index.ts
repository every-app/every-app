import type { LocalContext } from "@/context";
import enquirer from "enquirer";
import { findGatewayUrl } from "@/lib/gateway/resolve";
import {
  deleteGatewayCredential,
  normalizeGatewayUrl,
} from "@/lib/gateway/credentials";
import { eventSink, runReported } from "@/lib/output/run";

async function getDefaultGatewayUrl(): Promise<string> {
  try {
    return (await findGatewayUrl()) ?? "";
  } catch {
    return "";
  }
}

export async function logout(this: LocalContext): Promise<void> {
  const out = eventSink();
  await runReported(out, async () => {
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
    out.emit({
      type: "done",
      message: removed
        ? `Logged out of ${gatewayUrl}.`
        : `No stored credential found for ${gatewayUrl}.`,
      data: { gatewayUrl, removed },
    });
  });
}
