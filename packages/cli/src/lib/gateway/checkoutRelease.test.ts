/**
 * The Gateway build cache: a checkout's release kept by the tree hash of
 * the Gateway's sources, so a rebind after the first build doesn't build
 * again, and any edit to those sources builds anew.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNdjsonSink } from "@/lib/output/events";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import {
  checkoutSource,
  hashCheckoutTree,
  openCheckoutRelease,
  releaseCacheDir,
} from "./checkoutRelease";
import type { GatewayRelease } from "./release";

let root: string;
let builds: number;
let events: Array<Record<string, any>>;
const opened: GatewayRelease[] = [];

function write(file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** A checkout: the Gateway's sources and others, in a git repository. */
function checkout(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-checkout-"));
  write(".gitignore", "node_modules/\n.cloudflare/\n*.tar.gz\n");
  write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
  write("apps/every-app-gateway/package.json", '{"version":"0.2.0"}');
  write("apps/every-app-gateway/src/server.ts", "export const gateway = 1;\n");
  write("apps/every-app-gateway/drizzle/meta/_journal.json", '{"entries":[]}');
  write("packages/sdk/src/index.ts", "export const sdk = 1;\n");
  write("packages/perimeter/src/gateway.ts", "export const perimeter = 1;\n");
  write("packages/toolbus/src/index.ts", "export const toolbus = 1;\n");
  write("packages/cli/src/cli.ts", "export const cli = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
}

/** Commit everything, as of `date`. */
function commit(date: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  execFileSync("git", ["add", "-A"], { cwd: root, env });
  execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", date], { cwd: root, env });
}

/** A build that packs a release, as `build:release` does, and counts itself. */
const build = (during?: () => void) => async () => {
  builds += 1;
  during?.();
  return buildGatewayRelease({ builtAt: `2026-10-${10 + builds}T00:00:00.000Z` });
};

async function open(options: { during?: () => void; keep?: number } = {}) {
  const release = await openCheckoutRelease({
    root,
    out: createNdjsonSink((line) => events.push(JSON.parse(line))),
    build: build(options.during),
    keep: options.keep,
  });
  opened.push(release);
  return release;
}

const cached = () =>
  fs.existsSync(releaseCacheDir(root))
    ? fs.readdirSync(releaseCacheDir(root)).sort()
    : [];

beforeEach(() => {
  checkout();
  builds = 0;
  events = [];
});

afterEach(async () => {
  for (const release of opened.splice(0)) await release.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the Gateway build cache", () => {
  it("builds once, then hands back the cached release for the same sources", async () => {
    const tree = await hashCheckoutTree(root);
    expect(tree).toMatch(/^[0-9a-f]{64}$/);

    const first = await open();
    expect(builds).toBe(1);
    expect(first.source.treeSha256).toBe(tree);
    expect(cached()).toEqual([`${tree}.tar.gz`]);
    expect(events.at(-1)).toMatchObject({
      step: "gateway.release",
      status: "ok",
      data: { cached: false, treeSha256: tree },
    });

    const second = await open();
    expect(builds).toBe(1);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.source).toEqual(first.source);
    expect(events.at(-1)).toMatchObject({
      step: "gateway.release",
      data: { cached: true, treeSha256: tree },
    });
  });

  it("builds again after any change to the Gateway, the SDK, perimeter or toolbus, committed or not", async () => {
    await open();
    for (const change of [
      () => write("packages/sdk/src/index.ts", "export const sdk = 2;\n"),
      () => write("packages/perimeter/src/new.ts", "export const untracked = 1;\n"),
      () => write("apps/every-app-gateway/src/server.ts", "export const gateway = 2;\n"),
      () => write("packages/toolbus/src/index.ts", "export const toolbus = 2;\n"),
      () => fs.rmSync(path.join(root, "packages/sdk/src/index.ts")),
      () => write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n"),
    ]) {
      const before = builds;
      change();
      await open();
      expect(builds).toBe(before + 1);
    }
  });

  it("doesn't build again for what the release isn't built from, or what git ignores", async () => {
    await open();
    write("packages/cli/src/cli.ts", "export const cli = 2;\n");
    write("apps/every-app-gateway/node_modules/dep/index.js", "x");
    write("apps/every-app-gateway/.cloudflare/output/v0/config.json", "{}");

    await open();

    expect(builds).toBe(1);
  });

  it("doesn't keep a build whose sources changed while it ran", async () => {
    const release = await open({
      during: () => write("packages/sdk/src/index.ts", "export const sdk = 3;\n"),
    });

    expect(release.source.treeSha256).toBeNull();
    expect(cached()).toEqual([]);
  });

  it("keeps only the most recent builds", async () => {
    for (const n of [1, 2, 3]) {
      write("apps/every-app-gateway/src/server.ts", `export const gateway = ${n};\n`);
      await open({ keep: 2 });
    }
    const latest = await hashCheckoutTree(root);

    expect(cached()).toHaveLength(2);
    expect(cached()).toContain(`${latest}.tar.gz`);
  });

  it("builds again over a damaged cached release", async () => {
    await open();
    const [file] = cached();
    fs.writeFileSync(path.join(releaseCacheDir(root), file!), "not a tarball");

    await open();

    expect(builds).toBe(2);
    expect(cached()).toEqual([file]);
  });

  it("orders a release by when the Gateway's sources were last committed, not when it was built", async () => {
    commit("2026-10-01T00:00:00Z");
    // A later commit that touches none of them.
    write("packages/cli/src/cli.ts", "export const cli = 2;\n");
    commit("2026-10-05T00:00:00Z");

    const built = await open();
    const cachedAgain = await open();

    const committedAt = Date.parse("2026-10-01T00:00:00Z");
    expect(built.source.order.committedAt).toBe(committedAt);
    expect(cachedAgain.source.order.committedAt).toBe(committedAt);
    await expect(checkoutSource(root)).resolves.toEqual({
      treeSha256: await hashCheckoutTree(root),
      origin: { kind: "checkout" },
      // No gateway-v0.2.0 tag: the version alone doesn't say what it is.
      commit: { hash: expect.stringMatching(/^[0-9a-f]{7,}$/), uncommittedChanges: false },
      version: "0.2.0",
      order: { schema: 0, committedAt },
    });
  });

  it("builds every time, keeping nothing, where git can't list the checkout", async () => {
    fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
    expect(await hashCheckoutTree(root)).toBeNull();

    await open();
    await open();

    expect(builds).toBe(2);
    expect(cached()).toEqual([]);
  });
});
