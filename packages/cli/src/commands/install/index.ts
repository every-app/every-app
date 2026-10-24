import { fetchAppRelease } from "@/lib/app/release";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { runCommand } from "@/lib/output/run";
import { deployApp } from "../deploy/deployApp";
import { deployDone } from "../deploy";
import type { AppDeployFlags } from "../flags";

/**
 * `everyapp install <source>`: the app release `source` names (a GitHub
 * repository, a tarball's URL or a file; lib/app/release.ts), deployed
 * from the current directory with no checkout of the app. The same
 * pipeline, flags and events as `deploy`, with the build steps skipped:
 * the release was built and checked by its publisher. The takeover flags
 * matter here too: a release can drop a class or a Workflow, and its
 * hostname and inbound domains are checked the same way.
 */
export async function install(flags: AppDeployFlags, source: string): Promise<void> {
  await runCommand(flags, async (out) => {
    const gateway = requestedGatewayUrl(flags.gateway);
    const release = await fetchAppRelease(source, { out });
    try {
      const result = await deployApp({
        cwd: process.cwd(),
        manifest: release.manifest,
        release,
        gateway,
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
      out.emit({ type: "done", ...deployDone(result) });
    } finally {
      await release.cleanup();
    }
  });
}
