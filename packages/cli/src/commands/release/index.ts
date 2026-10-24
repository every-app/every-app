import { APP_RELEASE_TARBALL } from "@/lib/app/release";
import { loadEveryAppManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import { runCommand } from "@/lib/output/run";
import { bundleApp } from "./bundleApp";

interface ReleaseCommandFlags {
  out?: string;
  json?: boolean;
  verbose?: boolean;
}

/**
 * `everyapp release [--out <file>]`: the app in this directory, built and
 * checked as a deploy would, packed as a release (bundleApp.ts) instead
 * of deployed. The `done` says where it is and how to install it.
 */
export async function release(flags: ReleaseCommandFlags): Promise<void> {
  await runCommand(flags, async (out) => {
    const cwd = process.cwd();
    const result = await bundleApp({
      cwd,
      manifest: await loadEveryAppManifest(cwd),
      outFile: flags.out ?? APP_RELEASE_TARBALL,
      out,
      verbose: flags.verbose,
    });
    out.emit({
      type: "done",
      data: {
        ...result,
        next: [{ command: `${CLI} install ${result.shown}`, note: "installs it" }],
      },
    });
  });
}
