import type { LocalContext } from "@/context";
import { runGatewayCommand } from "../setup";
import { runGatewayDeploy, type GatewayDeployFlags } from "../setup/runSetup";

export async function deploy(
  this: LocalContext,
  flags: GatewayDeployFlags,
): Promise<void> {
  await runGatewayCommand(flags, (out, deps) => runGatewayDeploy(flags, out, deps));
}
