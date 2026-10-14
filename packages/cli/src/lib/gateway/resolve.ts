import { EveryAppError } from "@/lib/errors";
import { listCachedInstalls } from "@/lib/install/state";
import {
  listGatewayCredentials,
  normalizeGatewayUrl,
} from "./credentials";

/**
 * The gateway an app command talks to: `--gateway`, then
 * EVERYAPP_GATEWAY_URL, then the only gateway this machine has a deploy token
 * for, then the only one it deployed. Null when none of those decide it.
 */
export async function findGatewayUrl(flag?: string): Promise<string | null> {
  const explicit = flag ?? process.env["EVERYAPP_GATEWAY_URL"];
  if (explicit) return normalizeGatewayUrl(explicit);

  const credentials = await listGatewayCredentials();
  if (credentials.length === 1) {
    return normalizeGatewayUrl(credentials[0]!.gatewayUrl);
  }
  const installs = await listCachedInstalls();
  if (credentials.length === 0 && installs.length === 1) {
    return `https://${installs[0]!.gatewayHost}`;
  }
  return null;
}

export async function resolveGatewayUrl(flag?: string): Promise<string> {
  const gatewayUrl = await findGatewayUrl(flag);
  if (gatewayUrl) return gatewayUrl;
  const credentials = await listGatewayCredentials();
  throw new EveryAppError(
    "GATEWAY_REQUIRED",
    credentials.length > 1
      ? `You're logged in to several gateways (${credentials.map((c) => c.gatewayUrl).join(", ")}); pass --gateway <url> or set EVERYAPP_GATEWAY_URL.`
      : "No gateway to use yet. Deploy one with `everyapp gateway deploy --domain <domain>`, or log in to yours with `everyapp login`.",
  );
}
