import type { LocalContext } from "@/context";
import { deployGateway, type DeployGatewayFlags } from "./deployGateway";

export async function deploy(
  this: LocalContext,
  flags: DeployGatewayFlags,
): Promise<void> {
  await deployGateway(flags, "deploy");
}
