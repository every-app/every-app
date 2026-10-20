import type { LocalContext } from "@/context";
import { APP_RELEASE_TARBALL, fetchAppRelease, type AppRelease } from "@/lib/app/release";
import { EveryAppError } from "@/lib/errors";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { loadEveryAppManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import { eventSink, runReported } from "@/lib/output/run";
import { bundleApp } from "./bundleApp";
import { deployApp } from "./deployApp";
import { deployToGateway, hostedDeployTarget } from "./deployToGateway";

interface DeployCommandFlags {
  gateway?: string;
  "account-id"?: string;
  verbose?: boolean;
  yes?: boolean;
  json?: boolean;
  "allow-delete-durable-object-data"?: boolean;
  "allow-delete-workflows"?: boolean;
  "force-dns"?: boolean;
  "enable-email-routing"?: boolean;
  "no-wait"?: boolean;
  shared?: boolean;
  "bundle-only"?: boolean;
  out?: string;
}

/**
 * `everyapp deploy [<source>]`: the app in this directory, built here, or
 * the app release `source` names (a GitHub repository, a tarball's URL or
 * a file; lib/app/release.ts). With EVERYAPP_DEPLOY_TOKEN, through a
 * hosted gateway's deploy API (deployToGateway.ts); otherwise no question
 * first (unless there is no Gateway yet: then it offers to install one).
 * The first line says what is deployed where (`Deploying todo to Acme`),
 * and the last that it is live, at its URL. `--bundle-only` packs the app
 * in this directory as a release instead (bundleApp.ts).
 */
export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
  source?: string,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const cwd = process.cwd();
      refuseBundleFlags(flags, source);
      if (flags["bundle-only"]) {
        const result = await bundleApp({
          cwd,
          manifest: await loadEveryAppManifest(cwd),
          outFile: flags.out ?? APP_RELEASE_TARBALL,
          out,
          verbose: flags.verbose,
        });
        out.emit({ type: "done", data: result });
        return;
      }
      const hosted = hostedDeployTarget({
        ...flags,
        gateway: requestedGatewayUrl(flags.gateway),
      });
      const release = source ? await fetchAppRelease(source, { out }) : undefined;
      try {
        await deployFrom({ cwd, flags, out, hosted, release });
      } finally {
        await release?.cleanup();
      }
    },
    { verbose: flags.verbose },
  );
}

/** `--bundle-only` packs this directory's app, alone; `--out` is its. */
export function refuseBundleFlags(
  flags: Pick<DeployCommandFlags, "bundle-only" | "out">,
  source: string | undefined,
): void {
  if (flags["bundle-only"] && source) {
    throw new EveryAppError(
      "BUNDLE_ONLY_WITH_SOURCE",
      `--bundle-only packs the app in this directory; ${source} is a release already. Run \`${CLI} deploy ${source}\` to deploy it, or --bundle-only without it.`,
    );
  }
  if (!flags["bundle-only"] && flags.out !== undefined) {
    throw new EveryAppError(
      "OUT_WITHOUT_BUNDLE_ONLY",
      "--out names the release --bundle-only writes; add --bundle-only, or deploy without --out.",
    );
  }
}

async function deployFrom({
  cwd,
  flags,
  out,
  hosted,
  release,
}: {
  cwd: string;
  flags: DeployCommandFlags;
  out: ReturnType<typeof eventSink>;
  hosted: ReturnType<typeof hostedDeployTarget>;
  release: AppRelease | undefined;
}): Promise<void> {
  const manifest = release?.manifest ?? (await loadEveryAppManifest(cwd));
      if (hosted) {
        const result = await deployToGateway({
          cwd,
          manifest,
          release,
          ...hosted,
          out,
          verbose: flags.verbose,
          wait: !flags["no-wait"],
        });
        out.emit({
          type: "done",
          data: {
            url: result.liveUrl,
            workerName: result.workerName,
            versionId: result.versionId,
            jobId: result.jobId,
            status: result.status,
            live: false,
          },
        });
        return;
      }
      const result = await deployApp({
        cwd,
        manifest,
        release,
        gateway: requestedGatewayUrl(flags.gateway),
        accountId: flags["account-id"],
        out,
        json: flags.json,
        verbose: flags.verbose,
        allowDeleteDurableObjectData:
          flags["allow-delete-durable-object-data"],
        allowDeleteWorkflows: flags["allow-delete-workflows"],
        forceDns: flags["force-dns"],
        enableEmailRouting: flags["enable-email-routing"],
        shared: flags.shared,
        waitForLive: !flags["no-wait"],
        offerInstall: { yes: flags.yes },
      });
      // `app.live` said it to a person already (or that it goes live on its
      // first visit).
      out.emit({
        type: "done",
        data: {
          url: result.liveUrl,
          workerName: result.workerName,
          versionId: result.versionId,
          live: result.live,
        },
      });
}
