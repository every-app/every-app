/**
 * `everyapp release --publish`: the packed release, published as a GitHub
 * release of the repository a GitHub Actions run builds, with the asset
 * `everyapp install https://github.com/<owner>/<repo>` downloads. What the
 * app repositories' Release workflow used to do in shell, so the workflow
 * is one step (starter/.github/workflows/release.yml):
 *
 *   pull_request        nothing is published (the build is the check)
 *   push to the default branch
 *                       v<package.json version>, or
 *                       v<version>-<yyyymmdd>-<sha7> when that tag exists
 *   push of a tag       that tag
 *   workflow_dispatch   a draft, v<version>-<yyyymmdd>-<sha7>
 *   anything else       nothing is published (another branch, a schedule)
 *
 * It reads the run from GitHub's own variables (GITHUB_REPOSITORY,
 * GITHUB_SHA, GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME,
 * GITHUB_EVENT_PATH for the default branch, GITHUB_API_URL) and the token
 * from GITHUB_TOKEN (or GH_TOKEN), and talks to the REST API with fetch:
 * no `gh`. --dry-run plans the release and writes nothing.
 */
import fsp from "node:fs/promises";
import { EveryAppError } from "@/lib/errors";
import { APP_RELEASE_TARBALL } from "@/lib/app/release";

export interface GithubRun {
  /** owner/repo */
  repo: string;
  sha: string;
  eventName: string;
  refType: string;
  refName: string;
  /** The repository's default branch, from the event payload; `main` when it can't be read. */
  defaultBranch: string;
  apiUrl: string;
  token: string | null;
}

type ReleasePlan =
  | { publish: false; reason: string }
  | { publish: true; tag: string; draft: boolean };

const env = (vars: NodeJS.ProcessEnv, name: string) => {
  const value = vars[name]?.trim();
  return value ? value : null;
};

/** The GitHub Actions run this is, from its variables. */
export async function githubRun(vars: NodeJS.ProcessEnv = process.env): Promise<GithubRun> {
  const missing = ["GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_EVENT_NAME"].filter((name) => !env(vars, name));
  if (missing.length > 0) {
    throw new EveryAppError(
      "GITHUB_RUN_MISSING",
      `--publish runs in GitHub Actions: ${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set`,
      {
        fix: "run it from the app repository's Release workflow (starter/.github/workflows/release.yml in the EveryApp repository), or attach the tarball to a GitHub release by hand",
        data: { missing },
      },
    );
  }
  let defaultBranch = "main";
  const eventPath = env(vars, "GITHUB_EVENT_PATH");
  if (eventPath) {
    try {
      const payload = JSON.parse(await fsp.readFile(eventPath, "utf8")) as {
        repository?: { default_branch?: unknown };
      };
      if (typeof payload.repository?.default_branch === "string") defaultBranch = payload.repository.default_branch;
    } catch {
      // No payload to read: `main`.
    }
  }
  return {
    repo: env(vars, "GITHUB_REPOSITORY")!,
    sha: env(vars, "GITHUB_SHA")!,
    eventName: env(vars, "GITHUB_EVENT_NAME")!,
    refType: env(vars, "GITHUB_REF_TYPE") ?? "branch",
    refName: env(vars, "GITHUB_REF_NAME") ?? "",
    defaultBranch,
    apiUrl: (env(vars, "GITHUB_API_URL") ?? "https://api.github.com").replace(/\/+$/, ""),
    token: env(vars, "GITHUB_TOKEN") ?? env(vars, "GH_TOKEN"),
  };
}

/** `v<version>-<yyyymmdd>-<sha7>`: a build of a version already released. */
function stampedTag(version: string, sha: string, now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `v${version}-${day}-${sha.slice(0, 7)}`;
}

/** Which release this run publishes, if any. `tagExists` is asked only for a push to the default branch. */
export async function planRelease(
  run: GithubRun,
  version: string,
  { tagExists, now = new Date() }: { tagExists: (tag: string) => Promise<boolean>; now?: Date },
): Promise<ReleasePlan> {
  if (run.eventName === "workflow_dispatch") {
    return { publish: true, tag: stampedTag(version, run.sha, now), draft: true };
  }
  if (run.eventName !== "push") {
    return { publish: false, reason: `a ${run.eventName} run publishes nothing; the build is the check` };
  }
  if (run.refType === "tag") return { publish: true, tag: run.refName, draft: false };
  if (run.refName !== run.defaultBranch) {
    return {
      publish: false,
      reason: `${run.refName} isn't the default branch (${run.defaultBranch}); only its pushes publish`,
    };
  }
  const tag = `v${version}`;
  return { publish: true, tag: (await tagExists(tag)) ? stampedTag(version, run.sha, now) : tag, draft: false };
}

/** The release's notes: what it was built from and the command that installs it. */
export function releaseNotes({ repo, sha, sha256 }: { repo: string; sha: string; sha256: string }): string {
  return [
    `Built from ${sha} by \`everyapp release --publish\`.`,
    "",
    "Install it on your Gateway, or update it there:",
    "",
    "```sh",
    `everyapp install https://github.com/${repo}`,
    "```",
    "",
    `${APP_RELEASE_TARBALL} SHA-256: ${sha256}`,
    "",
  ].join("\n");
}

function headers(run: GithubRun, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "everyapp-release",
    ...(run.token ? { authorization: `Bearer ${run.token}` } : {}),
    ...extra,
  };
}

async function failed(what: string, response: Response): Promise<EveryAppError> {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") detail = parsed.message;
  } catch {
    // Not JSON: the text.
  }
  return new EveryAppError("RELEASE_PUBLISH_FAILED", `GitHub refused to ${what} (${response.status})${detail ? `: ${detail}` : ""}`, {
    retryable: response.status >= 500 || response.status === 429,
    fix:
      response.status === 401 || response.status === 403 || response.status === 404
        ? "give the job permissions: contents: write and pass GITHUB_TOKEN: ${{ github.token }} to the step"
        : undefined,
    data: { status: response.status },
  });
}

/** Whether the repository has the tag already. */
export function githubTagExists(run: GithubRun, fetchImpl: typeof fetch = fetch) {
  return async (tag: string): Promise<boolean> => {
    const response = await fetchImpl(`${run.apiUrl}/repos/${run.repo}/git/ref/tags/${encodeURIComponent(tag)}`, {
      headers: headers(run),
    });
    if (response.status === 404) return false;
    if (!response.ok) throw await failed(`look up the tag ${tag}`, response);
    return true;
  };
}

/**
 * Create the release at the run's commit, then upload the tarball as its
 * asset. A release left without its asset is deleted, so a rerun starts
 * clean.
 */
export async function publishGithubRelease({
  run,
  plan,
  tarball,
  notes,
  fetch: fetchImpl = fetch,
}: {
  run: GithubRun;
  plan: { tag: string; draft: boolean };
  tarball: string;
  notes: string;
  fetch?: typeof fetch;
}): Promise<{ url: string; id: number }> {
  if (!run.token) {
    throw new EveryAppError("GITHUB_RUN_MISSING", "--publish needs a token to create the release: GITHUB_TOKEN isn't set", {
      fix: "pass GITHUB_TOKEN: ${{ github.token }} to the step, with permissions: contents: write on the job",
      data: { missing: ["GITHUB_TOKEN"] },
    });
  }
  const created = await fetchImpl(`${run.apiUrl}/repos/${run.repo}/releases`, {
    method: "POST",
    headers: headers(run, { "content-type": "application/json" }),
    body: JSON.stringify({
      tag_name: plan.tag,
      target_commitish: run.sha,
      name: plan.tag,
      body: notes,
      draft: plan.draft,
    }),
  });
  if (!created.ok) throw await failed(`create the release ${plan.tag}`, created);
  const release = (await created.json()) as { id: number; html_url: string; upload_url: string };
  const uploadUrl = `${release.upload_url.replace(/\{.*\}$/, "")}?name=${encodeURIComponent(APP_RELEASE_TARBALL)}`;
  const body = await fsp.readFile(tarball);
  const uploaded = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: headers(run, { "content-type": "application/gzip", "content-length": String(body.byteLength) }),
    body,
  });
  if (!uploaded.ok) {
    const error = await failed(`upload ${APP_RELEASE_TARBALL} to the release ${plan.tag}`, uploaded);
    await fetchImpl(`${run.apiUrl}/repos/${run.repo}/releases/${release.id}`, {
      method: "DELETE",
      headers: headers(run),
    }).catch(() => undefined);
    throw error;
  }
  return { url: release.html_url, id: release.id };
}
