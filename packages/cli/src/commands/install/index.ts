import { fetchAppRelease } from "@/lib/app/release";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { CLI } from "@/lib/output/command";
import { CancelledError } from "@/lib/errors";
import { canPromptInTerminal, confirmYesAtTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { configure } from "../configure";
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
 * hostname and inbound domains are checked the same way. At a terminal,
 * an app that needs setup (a key, or one of its plain `settings`) is
 * offered `configure` right after, which asks for each.
 */
export async function install(flags: AppDeployFlags, source: string): Promise<void> {
  let needsSetup: string | null = null;
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
        registerProviders: flags["register-providers"],
        offerInstall: { yes: flags.yes },
      });
      out.emit({ type: "done", ...deployDone(result) });
      if (result.next.some((step) => step.command.startsWith(`${CLI} configure `))) {
        needsSetup = release.manifest.id;
      }
    } finally {
      await release.cleanup();
    }
  });
  // What the release declares and the install lacks, asked for now.
  if (needsSetup && canPromptInTerminal(flags.json ?? false)) {
    const app: string = needsSetup;
    const now = await confirmYesAtTerminal(`Set up ${app} now?`, [
      `${CLI} configure ${app} asks for each setting it needs.`,
    ]).catch((error: unknown) => {
      // Ctrl-C: the install stands; configure is the next step it named.
      if (error instanceof CancelledError) return false;
      throw error;
    });
    if (now) {
      await configure({ gateway: flags.gateway, "account-id": flags["account-id"], verbose: flags.verbose }, app);
    }
  }
}
