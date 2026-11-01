/**
 * `everyapp release --publish`: which release a GitHub Actions run
 * publishes, its notes, and the REST calls that publish it, against a fake
 * fetch: nothing here reaches the network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EveryAppError } from "@/lib/errors";
import { release } from ".";
import {
  githubRun,
  githubTagExists,
  planRelease,
  publishGithubRelease,
  releaseNotes,
  type GithubRun,
} from "./publish";

const NOW = new Date("2026-10-26T12:00:00Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const run = (overrides: Partial<GithubRun> = {}): GithubRun => ({
  repo: "acme/notes",
  sha: SHA,
  eventName: "push",
  refType: "branch",
  refName: "main",
  defaultBranch: "main",
  apiUrl: "https://api.github.com",
  token: "ghs_test",
  ...overrides,
});

const never = async () => {
  throw new Error("no tag lookup expected");
};

describe("planRelease", () => {
  it("publishes v<version> on a push to the default branch", async () => {
    expect(await planRelease(run(), "1.4.0", { tagExists: async () => false, now: NOW })).toEqual({
      publish: true,
      tag: "v1.4.0",
      draft: false,
    });
  });

  it("stamps the tag with the date and commit when v<version> exists", async () => {
    const asked: string[] = [];
    const plan = await planRelease(run(), "1.4.0", {
      tagExists: async (tag) => (asked.push(tag), true),
      now: NOW,
    });
    expect(asked).toEqual(["v1.4.0"]);
    expect(plan).toEqual({ publish: true, tag: "v1.4.0-20261026-0123456", draft: false });
  });

  it("publishes a pushed tag under its own name", async () => {
    expect(
      await planRelease(run({ refType: "tag", refName: "v2.0.0" }), "1.4.0", { tagExists: never, now: NOW }),
    ).toEqual({ publish: true, tag: "v2.0.0", draft: false });
  });

  it("publishes a stamped draft on a manual run, whatever the branch", async () => {
    expect(
      await planRelease(run({ eventName: "workflow_dispatch", refName: "feature" }), "1.4.0", {
        tagExists: never,
        now: NOW,
      }),
    ).toEqual({ publish: true, tag: "v1.4.0-20261026-0123456", draft: true });
  });

  it("publishes nothing on a pull request or another branch", async () => {
    expect(
      await planRelease(run({ eventName: "pull_request", refName: "12/merge" }), "1.4.0", { tagExists: never }),
    ).toMatchObject({ publish: false, reason: expect.stringContaining("pull_request") });
    expect(
      await planRelease(run({ refName: "feature", defaultBranch: "everyapp" }), "1.4.0", { tagExists: never }),
    ).toMatchObject({ publish: false, reason: expect.stringContaining("isn't the default branch (everyapp)") });
  });
});

describe("githubRun", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-publish-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads the run from GitHub's variables and the default branch from the event payload", async () => {
    const event = path.join(dir, "event.json");
    fs.writeFileSync(event, JSON.stringify({ repository: { default_branch: "everyapp" } }));
    expect(
      await githubRun({
        GITHUB_REPOSITORY: "acme/notes",
        GITHUB_SHA: SHA,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "everyapp",
        GITHUB_EVENT_PATH: event,
        GH_TOKEN: "ghs_x",
      }),
    ).toEqual(run({ refName: "everyapp", defaultBranch: "everyapp", token: "ghs_x" }));
  });

  it("refuses outside GitHub Actions", async () => {
    await expect(githubRun({})).rejects.toMatchObject({
      code: "GITHUB_RUN_MISSING",
      data: { missing: ["GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_EVENT_NAME"] },
    });
  });
});

describe("releaseNotes", () => {
  it("names the commit, the install command and the SHA-256", () => {
    expect(releaseNotes({ repo: "acme/notes", sha: SHA, sha256: "ab".repeat(32) })).toBe(
      [
        `Built from ${SHA} by \`everyapp release --publish\`.`,
        "",
        "Install it on your Gateway, or update it there:",
        "",
        "```sh",
        "everyapp install https://github.com/acme/notes",
        "```",
        "",
        `everyapp-release.tar.gz SHA-256: ${"ab".repeat(32)}`,
        "",
      ].join("\n"),
    );
  });
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake GitHub API: answers by method and path, records each call. */
function fakeGithub(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body;
    calls.push({
      method,
      url,
      headers: init.headers as Record<string, string>,
      body: typeof body === "string" ? JSON.parse(body) : body ? Buffer.from(body as Uint8Array).toString() : undefined,
    });
    const { pathname } = new URL(url);
    const answer = answers[`${method} ${pathname}`];
    return answer ? answer() : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const created = () =>
  Response.json(
    {
      id: 7,
      html_url: "https://github.com/acme/notes/releases/tag/v1.4.0",
      upload_url: "https://uploads.github.com/repos/acme/notes/releases/7/assets{?name,label}",
    },
    { status: 201 },
  );

describe("publishGithubRelease", () => {
  let tarball: string;
  beforeEach(() => {
    tarball = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-publish-")), "everyapp-release.tar.gz");
    fs.writeFileSync(tarball, "tarball bytes");
  });
  afterEach(() => fs.rmSync(path.dirname(tarball), { recursive: true, force: true }));

  it("creates the release at the run's commit and uploads the tarball as its asset", async () => {
    const github = fakeGithub({
      "POST /repos/acme/notes/releases": created,
      "POST /repos/acme/notes/releases/7/assets": () => Response.json({ id: 1 }, { status: 201 }),
    });
    const result = await publishGithubRelease({
      run: run(),
      plan: { tag: "v1.4.0", draft: false },
      tarball,
      notes: "notes",
      fetch: github.fetch,
    });
    expect(result).toEqual({ id: 7, url: "https://github.com/acme/notes/releases/tag/v1.4.0" });
    expect(github.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://api.github.com/repos/acme/notes/releases",
      "POST https://uploads.github.com/repos/acme/notes/releases/7/assets?name=everyapp-release.tar.gz",
    ]);
    expect(github.calls[0]!.body).toEqual({
      tag_name: "v1.4.0",
      target_commitish: SHA,
      name: "v1.4.0",
      body: "notes",
      draft: false,
    });
    expect(github.calls[0]!.headers["authorization"]).toBe("Bearer ghs_test");
    expect(github.calls[1]!.headers["content-type"]).toBe("application/gzip");
    expect(github.calls[1]!.body).toBe("tarball bytes");
  });

  it("deletes a release whose upload failed, and says why", async () => {
    const github = fakeGithub({
      "POST /repos/acme/notes/releases": created,
      "POST /repos/acme/notes/releases/7/assets": () => Response.json({ message: "Server Error" }, { status: 502 }),
      "DELETE /repos/acme/notes/releases/7": () => new Response(null, { status: 204 }),
    });
    const error = await publishGithubRelease({
      run: run(),
      plan: { tag: "v1.4.0", draft: false },
      tarball,
      notes: "notes",
      fetch: github.fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EveryAppError);
    expect(error).toMatchObject({
      code: "RELEASE_PUBLISH_FAILED",
      retryable: true,
      message: "GitHub refused to upload everyapp-release.tar.gz to the release v1.4.0 (502): Server Error",
    });
    expect(github.calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("names the permission a refused token needs", async () => {
    const github = fakeGithub({
      "POST /repos/acme/notes/releases": () =>
        Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    });
    await expect(
      publishGithubRelease({ run: run(), plan: { tag: "v1.4.0", draft: false }, tarball, notes: "", fetch: github.fetch }),
    ).rejects.toMatchObject({
      code: "RELEASE_PUBLISH_FAILED",
      retryable: false,
      fix: expect.stringContaining("contents: write"),
    });
  });

  it("needs a token", async () => {
    await expect(
      publishGithubRelease({ run: run({ token: null }), plan: { tag: "v1", draft: false }, tarball, notes: "" }),
    ).rejects.toMatchObject({ code: "GITHUB_RUN_MISSING" });
  });
});

describe("githubTagExists", () => {
  it("is true on 200 and false on 404", async () => {
    const github = fakeGithub({ "GET /repos/acme/notes/git/ref/tags/v1.4.0": () => Response.json({}) });
    const exists = githubTagExists(run(), github.fetch);
    expect(await exists("v1.4.0")).toBe(true);
    expect(await exists("v1.5.0")).toBe(false);
  });
});

describe("everyapp release --publish", () => {
  let dir: string;
  let lines: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-publish-app-"));
    fs.writeFileSync(path.join(dir, "everyapp.config.ts"), 'export default { id: "notes", name: "Notes" };\n');
    fs.writeFileSync(path.join(dir, "everyapp-release.tar.gz"), "tarball bytes");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    lines = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => (lines.push(String(line)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const events = () => lines.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const bundle = (async () => ({
    tarball: path.join(dir, "everyapp-release.tar.gz"),
    shown: "./everyapp-release.tar.gz",
    version: "1.4.0",
    sha256: "ab".repeat(32),
  })) as never;
  const actions = {
    GITHUB_REPOSITORY: "acme/notes",
    GITHUB_SHA: SHA,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_NAME: "main",
    GITHUB_TOKEN: "ghs_test",
  };

  it("--dry-run plans the release and publishes nothing", async () => {
    const github = fakeGithub({});
    await release({ json: true, publish: true, "dry-run": true }, { env: actions, fetch: github.fetch, now: NOW, bundle });
    // Only the tag lookup: no release is created.
    expect(github.calls.map((call) => call.method)).toEqual(["GET"]);
    const publish = events().find((event) => event.step === "app.publish");
    expect(publish).toMatchObject({
      status: "skip",
      message: "Dry run: would publish the release v1.4.0 of acme/notes.",
      data: { tag: "v1.4.0", draft: false, dryRun: true },
    });
    expect(events().at(-1)).toMatchObject({
      type: "done",
      data: { published: { tag: "v1.4.0", draft: false, url: null, dryRun: true } },
    });
  });

  it("publishes and points the next step at the repository", async () => {
    const github = fakeGithub({
      "POST /repos/acme/notes/releases": created,
      "POST /repos/acme/notes/releases/7/assets": () => Response.json({ id: 1 }, { status: 201 }),
    });
    await release({ json: true, publish: true }, { env: actions, fetch: github.fetch, now: NOW, bundle });
    expect(events().at(-1)).toMatchObject({
      type: "done",
      data: {
        published: { tag: "v1.4.0", url: "https://github.com/acme/notes/releases/tag/v1.4.0", dryRun: false },
        next: [{ command: expect.stringMatching(/install https:\/\/github\.com\/acme\/notes$/) }],
      },
    });
  });

  it("refuses before building outside GitHub Actions", async () => {
    let built = false;
    await release(
      { json: true, publish: true },
      { env: {}, bundle: (async () => ((built = true), {})) as never },
    );
    expect(built).toBe(false);
    expect(events().at(-1)).toMatchObject({ type: "error", code: "GITHUB_RUN_MISSING" });
  });
});
