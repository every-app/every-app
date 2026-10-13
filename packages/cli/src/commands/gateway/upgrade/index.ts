import type { LocalContext } from "@/context";
import {
  deployGateway,
  type DeployGatewayFlags,
} from "../deploy/deployGateway";

export async function upgrade(
  this: LocalContext,
  flags: DeployGatewayFlags,
): Promise<void> {
  await deployGateway(flags, "upgrade");
}
