import { runGatewayCommand } from "../setup";
import { runGatewayDeploy, type GatewayDeployFlags } from "../setup/runSetup";

/**
 * `everyapp update`: the Gateway the login finds, deployed from this
 * checkout (after a git pull). Setup's upgrade path with none of its
 * install questions: it never installs a Gateway.
 */
export async function update(flags: GatewayDeployFlags): Promise<void> {
  await runGatewayCommand(flags, (out, deps) => runGatewayDeploy(flags, out, deps));
}
