import path from "node:path";
import { cloneRepository } from "@/lib/git";
import { installDependencies } from "@/lib/package-manager";

// Constants
const EVERY_APP_REPO = "https://github.com/every-app/every-app.git";
const GATEWAY_RELATIVE_PATH = "apps/every-app-gateway";

/**
 * Clone the every-app repository and install dependencies
 */
export async function cloneAndInstall(
  tmpDir: string,
  verbose: boolean = false,
): Promise<string> {
  await cloneRepository(EVERY_APP_REPO, tmpDir, verbose);

  const gatewayPath = path.join(tmpDir, GATEWAY_RELATIVE_PATH);

  console.log();
  await installDependencies(
    gatewayPath,
    "Installing dependencies for Cloudflare Deployment...",
    verbose,
  );

  return gatewayPath;
}
