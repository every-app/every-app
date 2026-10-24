import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { loadEveryAppManifest } from "@/lib/manifest";
import { runCommand } from "@/lib/output/run";
import { liveDone } from "../appGateway";
import type { AppDeployFlags } from "../flags";
import { deployApp } from "./deployApp";

/**
 * `everyapp deploy`: the app in this directory, built here. No question
 * first (unless there is no Gateway yet: then it offers to install one).
 * The first line says what is deployed where (`Deploying todo to example.com (Acme)`),
 * and the last that it is live, at its URL. A published release is
 * `everyapp install <source>` (commands/install), and packing one is
 * `everyapp release` (commands/release).
 */
export async function deploy(flags: AppDeployFlags): Promise<void> {
  await runCommand(flags, async (out) => {
    const cwd = process.cwd();
    const result = await deployApp({
      cwd,
      manifest: await loadEveryAppManifest(cwd),
      gateway: requestedGatewayUrl(flags.gateway),
      accountId: flags["account-id"],
      out,
      json: flags.json,
      verbose: flags.verbose,
      allowDeleteDurableObjectData: flags["allow-delete-durable-object-data"],
      allowDeleteWorkflows: flags["allow-delete-workflows"],
      forceDns: flags["force-dns"],
      enableEmailRouting: flags["enable-email-routing"],
      waitForLive: !flags["no-wait"],
      offerInstall: { yes: flags.yes },
    });
    // `app.live` said it to a person already (or that it goes live on its
    // first visit).
    out.emit({ type: "done", ...deployDone(result) });
  });
}

/**
 * `deploy`'s and `install`'s `done`, for a script: where the app is, the
 * routes its manifest opens to the internet (`publicRoutes`, empty when
 * none) and what is left to run (`next`).
 */
export function deployDone(result: Awaited<ReturnType<typeof deployApp>>): {
  data: Record<string, unknown>;
} {
  return {
    data: {
      ...liveDone(result),
      organization: result.organizationName,
      publicRoutes: result.publicRoutes,
      ...(result.next.length > 0 ? { next: result.next } : {}),
    },
  };
}
