import { APP_RELEASE_TARBALL } from "@/lib/app/release";
import { loadEveryAppManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { runCommand } from "@/lib/output/run";
import { bundleApp } from "./bundleApp";
import {
  githubRun,
  githubTagExists,
  planRelease,
  publishGithubRelease,
  releaseNotes,
} from "./publish";

interface ReleaseCommandFlags {
  out?: string;
  publish?: boolean;
  "dry-run"?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export interface Published {
  tag: string;
  draft: boolean;
  /** The release's page; null on a dry run. */
  url: string | null;
  dryRun: boolean;
}

/**
 * `everyapp release [--out <file>] [--publish [--dry-run]]`: the app in
 * this directory, built and checked as a deploy would, packed as a release
 * (bundleApp.ts) instead of deployed; with --publish, published on GitHub
 * (publish.ts). The `done` says where it is and how to install it.
 */
export async function release(
  flags: ReleaseCommandFlags,
  seams: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: Date; bundle?: typeof bundleApp } = {},
): Promise<void> {
  await runCommand(flags, async (out) => {
    const cwd = process.cwd();
    const publishing = flags.publish === true || flags["dry-run"] === true;
    // Fail on a run that can't publish before the build, not after it.
    const run = publishing ? await githubRun(seams.env) : null;
    const result = await (seams.bundle ?? bundleApp)({
      cwd,
      manifest: await loadEveryAppManifest(cwd),
      outFile: flags.out ?? APP_RELEASE_TARBALL,
      out,
      verbose: flags.verbose,
    });
    const published = run
      ? await publish(out, {
          run,
          result,
          dryRun: flags["dry-run"] === true,
          fetch: seams.fetch ?? fetch,
          now: seams.now ?? new Date(),
        })
      : null;
    out.emit({
      type: "done",
      data: {
        ...result,
        ...(run ? { published } : {}),
        next: published?.url
          ? [{ command: `${CLI} install https://github.com/${run!.repo}`, note: "installs it on any Gateway" }]
          : [
              { command: `${CLI} install ${result.shown}`, note: "installs it on your Gateway" },
              {
                command: `${CLI} install <repository url>`,
                note: "installs it on any Gateway, once the tarball is attached to a GitHub release of the app's repository",
              },
            ],
      },
    });
  });
}

async function publish(
  out: EventSink,
  {
    run,
    result,
    dryRun,
    fetch: fetchImpl,
    now,
  }: {
    run: Awaited<ReturnType<typeof githubRun>>;
    result: { tarball: string; version: string; sha256: string };
    dryRun: boolean;
    fetch: typeof fetch;
    now: Date;
  },
): Promise<Published | null> {
  const plan = await planRelease(run, result.version, { tagExists: githubTagExists(run, fetchImpl), now });
  if (!plan.publish) {
    out.emit({
      type: "step",
      step: "app.publish",
      status: "skip",
      message: `Not publishing: ${plan.reason}.`,
      data: { repo: run.repo, eventName: run.eventName, reason: plan.reason },
    });
    return null;
  }
  const notes = releaseNotes({ repo: run.repo, sha: run.sha, sha256: result.sha256 });
  const base = { repo: run.repo, tag: plan.tag, draft: plan.draft, sha: run.sha };
  if (dryRun) {
    out.emit({
      type: "step",
      step: "app.publish",
      status: "skip",
      message: `Dry run: would publish ${plan.draft ? "a draft release" : "the release"} ${plan.tag} of ${run.repo}.`,
      data: { ...base, dryRun: true, notes },
    });
    return { tag: plan.tag, draft: plan.draft, url: null, dryRun: true };
  }
  out.emit({
    type: "step",
    step: "app.publish",
    status: "start",
    message: `Publishing ${plan.tag} on ${run.repo}...`,
    data: base,
  });
  const { url } = await publishGithubRelease({ run, plan, tarball: result.tarball, notes, fetch: fetchImpl });
  out.emit({
    type: "step",
    step: "app.publish",
    status: "ok",
    message: `Published ${plan.draft ? "the draft release" : "the release"} ${plan.tag}: ${url}`,
    data: { ...base, url },
  });
  return { tag: plan.tag, draft: plan.draft, url, dryRun: false };
}
