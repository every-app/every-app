/**
 * `everyapp deploy --bundle-only`: build the app in this directory as a
 * deploy would (tenant-neutral, lib/app/buildApp.ts), check its Build
 * Output against the app policy with the build's own placeholders
 * (`sentinelDeployTarget()`), check its migrations against its schema, and
 * pack it as an app release (lib/app/release.ts). No Gateway and no
 * Cloudflare login: for CI or by hand. Attach the tarball to a GitHub
 * release of the app's repository, which `everyapp deploy <github url>`
 * installs.
 */
import path from "node:path";
import { helperWorkerName, sentinelDeployTarget } from "@every-app/sdk/cloudflare";
import { buildApp } from "@/lib/app/buildApp";
import { prepareAppBuildOutput } from "@/lib/app/policy";
import { packAppRelease } from "@/lib/app/release";
import { resolveCfBinary } from "@/lib/cf/bin";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { installDependencies } from "@/lib/package-manager";
import { checkSchemaDrift } from "./steps/checkSchemaDrift";

export async function bundleApp({
  cwd,
  manifest,
  outFile,
  out,
  verbose = false,
  createCf = () => createCfRunner(),
  installDeps = installDependencies,
}: {
  cwd: string;
  manifest: EveryAppCliManifest;
  /** The tarball to write. */
  outFile: string;
  out: EventSink;
  verbose?: boolean;
  /** Seams for tests. */
  createCf?: () => CfRunner;
  installDeps?: typeof installDependencies;
}): Promise<{ tarball: string; shown: string; version: string; sha256: string }> {
  if (manifest.install !== false) {
    out.emit({ type: "step", step: "app.install", status: "start", message: "Installing dependencies..." });
    await installDeps({
      cwd,
      description: "Installing dependencies...",
      install: manifest.install,
      verbose,
    });
    out.emit({ type: "step", step: "app.install", status: "ok" });
  }
  out.emit({ type: "step", step: "app.build", status: "start", message: "Building..." });
  await buildApp({ cwd, cf: createCf(), buildCommand: manifest.build, verbose });
  const sentinel = sentinelDeployTarget(manifest);
  await prepareAppBuildOutput({
    cwd,
    inputs: {
      ...sentinel,
      helperWorkers: (manifest.workers ?? []).map((helper) =>
        helperWorkerName(sentinel.workerName, helper.name),
      ),
    },
  });
  out.emit({ type: "step", step: "app.build", status: "ok", message: "Built the app and checked its Build Output." });
  await checkSchemaDrift({ cwd, manifest, out });

  const tarball = path.resolve(cwd, outFile);
  // As a person names it again: `./everyapp-release.tar.gz`.
  const shown = path.isAbsolute(outFile) || outFile.startsWith(".") ? outFile : `./${outFile}`;
  const cfVersion = await resolveCfBinary(cwd).then(
    (cf) => cf.version,
    () => "unknown",
  );
  const release = await packAppRelease({ cwd, manifest, outFile: tarball, cfVersion });
  out.emit({
    type: "step",
    step: "app.release",
    status: "ok",
    message: `Packed ${manifest.id} ${release.version} (${release.sha256.slice(0, 12)}) into ${tarball}.`,
    data: { tarball, shown, appId: manifest.id, version: release.version, sha256: release.sha256 },
  });
  return { tarball, shown, version: release.version, sha256: release.sha256 };
}
