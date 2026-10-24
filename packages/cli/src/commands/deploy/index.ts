import type { LocalContext } from "@/context";
import { publicRoutesOf } from "@/lib/app/publicRoutes";
import { APP_RELEASE_TARBALL, fetchAppRelease, type AppRelease } from "@/lib/app/release";
import { EveryAppError } from "@/lib/errors";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { loadEveryAppManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { runCommand } from "@/lib/output/run";
import { liveDone } from "../appGateway";
import type { GatewayCommandFlags } from "../flags";
import { bundleApp } from "./bundleApp";
import { deployApp } from "./deployApp";
import { deployToGateway, hostedDeployTarget } from "./deployToGateway";

interface DeployCommandFlags extends GatewayCommandFlags {
  yes?: boolean;
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
 * The first line says what is deployed where (`Deploying todo to example.com (Acme)`),
 * and the last that it is live, at its URL. `--bundle-only` packs the app
 * in this directory as a release instead (bundleApp.ts).
 */
export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
  source?: string,
): Promise<void> {
  await runCommand(flags, async (out) => {
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
      out.emit({
        type: "done",
        data: {
          ...result,
          next: [{ command: `${CLI} deploy ${result.shown}`, note: "deploys it" }],
        },
      });
      return;
    }
    const gateway = requestedGatewayUrl(flags.gateway);
    const hosted = hostedDeployTarget({ ...flags, gateway });
    const release = source ? await fetchAppRelease(source, { out }) : undefined;
    try {
      await deployFrom({ cwd, flags, gateway, out, hosted, release });
    } finally {
      await release?.cleanup();
    }
  });
}

/** `--bundle-only` packs this directory's app, alone; `--out` is its. */
export function refuseBundleFlags(
  flags: Pick<DeployCommandFlags, "bundle-only" | "out">,
  source: string | undefined,
): void {
  if (flags["bundle-only"] && source) {
    throw new EveryAppError(
      "BUNDLE_ONLY_WITH_SOURCE",
      "--bundle-only packs the app in this directory, not a release URL",
      { rerun: `${CLI} deploy ${source}`, rerunNote: "deploys that release" },
    );
  }
  if (!flags["bundle-only"] && flags.out !== undefined) {
    throw new EveryAppError("OUT_WITHOUT_BUNDLE_ONLY", "--out needs --bundle-only", {
      fix: "add --bundle-only, or drop --out",
    });
  }
}

async function deployFrom({
  cwd,
  flags,
  gateway,
  out,
  hosted,
  release,
}: {
  cwd: string;
  flags: DeployCommandFlags;
  /** The gateway `--gateway` or EVERYAPP_GATEWAY_URL names. */
  gateway: string | undefined;
  out: EventSink;
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
        live: result.live,
        publicRoutes: publicRoutesOf(manifest),
      },
    });
    return;
  }
  const result = await deployApp({
    cwd,
    manifest,
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
    shared: flags.shared,
    waitForLive: !flags["no-wait"],
    offerInstall: { yes: flags.yes },
  });
  // `app.live` said it to a person already (or that it goes live on its
  // first visit).
  out.emit({ type: "done", ...deployDone(result) });
}

/**
 * `deploy`'s `done`, for a script: where the app is, the routes its
 * manifest opens to the internet (`publicRoutes`, empty when none) and
 * what is left to run (`next`).
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
