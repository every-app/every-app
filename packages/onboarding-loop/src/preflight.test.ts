import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locksDir, runsDir, sha256 } from "./accounts";
import { createCfApi, createFakeCfFetch, type FakeCfRoute } from "./cf";
import type { DockerInfo } from "./docker";
import { acquireAccountLock, recordTeardown } from "./lock";
import {
  isAllInterfaces,
  runPreflight,
  workersPlanOf,
  type PreflightOptions,
} from "./preflight";
import { createFakeSpawn } from "./spawn";
import type { Account } from "./types";

const ID = "0123456789abcdef0123456789abcdef";
const account: Account = {
  name: "loop-1",
  accountId: ID,
  zone: "everyapp-loop1.com",
  email: "owner@everyapp-loop1.com",
  token: "fake-token-abcdefghijklmnopqrstuv",
};
const NOW = Date.parse("2026-10-25T12:00:00Z");
const GIB = 1024 ** 3;

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-preflight-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const fakeDocker = (
  overrides: Partial<DockerInfo> = {},
  options: { stale?: string[]; imageExists?: boolean; skew?: number } = {},
) => {
  const removed: string[][] = [];
  return {
    removed,
    docker: {
      info: async (): Promise<DockerInfo> => ({
        engine: "29.8.2",
        memBytes: 16 * GIB,
        ncpu: 18,
        os: "linux",
        arch: "aarch64",
        ...overrides,
      }),
      listContainers: async () => options.stale ?? [],
      removeContainers: async (names: string[]) => {
        removed.push(names);
      },
      imageExists: async () => options.imageExists ?? true,
      clockSkewSeconds: async () => options.skew ?? 0.4,
    },
  };
};

const lsof = createFakeSpawn(() => ({
  stdout: [
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    "node 1 ben 20u IPv4 0 0t0 TCP 127.0.0.1:3000 (LISTEN)",
    "portless 2 ben 21u IPv6 0 0t0 TCP *:8080 (LISTEN)",
  ],
})).spawn;

const options = (
  configDir: string,
  overrides: Partial<PreflightOptions> = {},
): PreflightOptions => ({
  account,
  runId: "2026-10-25T12:00-script-abc123",
  dryRun: true,
  image: "everyapp-loop:abc",
  configDir,
  docker: fakeDocker().docker,
  cf: null,
  env: { PATH: "/bin" },
  spawn: lsof,
  now: () => NOW,
  ...overrides,
});

const cfRoutes = (
  extra: FakeCfRoute[] = [],
  accounts: string[] = [ID],
): FakeCfRoute[] => [
  ...extra,
  {
    method: "GET",
    path: /^\/user\/tokens\/verify$/,
    reply: () => ({ result: { id: "t", status: "active" } }),
  },
  {
    method: "GET",
    path: /^\/accounts$/,
    reply: () => ({ result: accounts.map((id) => ({ id })) }),
  },
  {
    method: "GET",
    path: /^\/zones$/,
    reply: () => ({
      result: [{ id: "z1", name: "everyapp-loop1.com", status: "active" }],
    }),
  },
  {
    method: "GET",
    path: /\/subscriptions$/,
    reply: () => ({
      result: [
        {
          state: "Paid",
          rate_plan: { id: "workers_paid", public_name: "Workers Paid" },
        },
      ],
    }),
  },
  {
    method: "GET",
    path: /\/workers\/subdomain$/,
    reply: () => ({
      status: 404,
      errors: [{ code: 10007, message: "not found" }],
    }),
  },
];
const cfOf = (routes: FakeCfRoute[]) =>
  createCfApi({
    token: account.token,
    accountId: ID,
    fetch: createFakeCfFetch(routes).fetch,
  });
const docsFetch = async () =>
  new Response("", {
    status: 302,
    headers: { location: "https://everyapp.com/" },
  });

describe("preflight (dry run: no network)", () => {
  it("runs every local check, skips each network check with the reason, takes and releases the lock", async () => {
    const dir = tempDir();
    const result = await runPreflight(options(dir));
    expect(result.ok).toBe(true);
    expect(result.reasonCode).toBeNull();
    const byName = Object.fromEntries(
      result.checks.map((check) => [check.name, check.status]),
    );
    expect(byName).toEqual({
      env: "ok",
      account: "ok",
      rotate: "ok",
      lock: "ok",
      teardown_gap: "ok",
      docker: "ok",
      stale_containers: "skip",
      clock: "ok",
      listeners: "warn",
      token: "skip",
      zone: "skip",
      plan: "skip",
      workers_subdomain: "skip",
      docs_url: "skip",
    });
    expect(
      result.checks.find((check) => check.name === "token")?.detail,
    ).toMatch(/--dry-run: no network call/);
    expect(result.docker?.engine).toBe("29.8.2");
    expect(result.listeners.allInterfaces).toEqual([
      "portless 2 ben 21u IPv6 0 0t0 TCP *:8080 (LISTEN)",
    ]);
    expect(fs.existsSync(path.join(locksDir(dir), `${ID}.json`))).toBe(true);
    result.release();
    expect(fs.existsSync(path.join(locksDir(dir), `${ID}.json`))).toBe(false);
  });

  it("refuses an inherited CLOUDFLARE_API_TOKEN before anything else", async () => {
    const result = await runPreflight(
      options(tempDir(), { env: { CLOUDFLARE_API_TOKEN: "x" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      {
        name: "env",
        status: "fail",
        detail: expect.stringContaining("CLOUDFLARE_API_TOKEN"),
      },
    ]);
  });

  it("refuses a token or provider key an earlier run saw echoed", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(runsDir(dir), "2026-10-24T20:00-claude-x"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(runsDir(dir), "2026-10-24T20:00-claude-x", "rotate.json"),
      JSON.stringify({
        values: [
          { name: "provider_key", sha256: sha256("sk-ant-fake-key-000000") },
        ],
      }),
    );
    const result = await runPreflight(
      options(dir, {
        provider: {
          name: "ANTHROPIC_API_KEY",
          value: "sk-ant-fake-key-000000",
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: "rotate",
      status: "fail",
      detail: expect.stringContaining("ROTATE: ANTHROPIC_API_KEY"),
    });
    expect(result.checks.at(-1)?.detail).not.toContain(
      "sk-ant-fake-key-000000",
    );
  });

  it("a held lock and a too-recent teardown each stop the run", async () => {
    const dir = tempDir();
    const held = acquireAccountLock(locksDir(dir), ID, "other-run", {
      now: NOW - 1000,
    });
    const locked = await runPreflight(options(dir));
    expect(locked.ok).toBe(false);
    expect(locked.checks.at(-1)).toMatchObject({
      name: "lock",
      status: "fail",
      detail: expect.stringContaining("other-run"),
    });
    held.release();
    recordTeardown(
      locksDir(dir),
      ID,
      new Date(NOW - 10 * 60 * 1000).toISOString(),
    );
    const recent = await runPreflight(options(dir));
    expect(recent.ok).toBe(false);
    expect(recent.reasonCode).toBe("dns_negative_cache");
    expect(recent.checks.at(-1)?.detail).toMatch(/20 min too recently/);
    expect(fs.existsSync(path.join(locksDir(dir), `${ID}.json`))).toBe(false);

    // With wait the run sleeps the remaining 20 minutes (lock held) and goes on.
    let clock = NOW;
    const slept: number[] = [];
    const logged: string[] = [];
    const waited = await runPreflight(
      options(dir, {
        now: () => clock,
        wait: {
          sleep: async (ms) => {
            slept.push(ms);
            clock += ms;
          },
          log: (line) => logged.push(line),
        },
      }),
    );
    expect(slept).toEqual([20 * 60 * 1000]);
    expect(logged).toEqual([
      expect.stringMatching(
        /^wait teardown_gap {2}loop-1 was wiped at .*; waiting 20 min/,
      ),
    ]);
    expect(waited.checks.find((c) => c.name === "teardown_gap")).toMatchObject({
      status: "ok",
      detail: expect.stringMatching(/^waited 20 min for the 30-minute gap/),
    });
    // The sleep is a phase of the record (durationS leaves it out); none without a wait.
    expect(waited.waits).toEqual([
      {
        name: "preflight.gap_wait",
        startedAt: new Date(NOW).toISOString(),
        durationS: 20 * 60,
      },
    ]);
    expect(recent.waits).toEqual([]);
    waited.release();
  });

  it("with wait, a lock another live run holds is waited for (15 s polls) and taken when released; the wait is a phase", async () => {
    const dir = tempDir();
    const held = acquireAccountLock(locksDir(dir), ID, "other-run", {
      now: NOW - 1000,
    });
    let clock = NOW;
    let polls = 0;
    const logged: string[] = [];
    const result = await runPreflight(
      options(dir, {
        now: () => clock,
        wait: {
          sleep: async (ms) => {
            polls += 1;
            clock += ms;
            if (polls === 3) held.release();
          },
          log: (line) => logged.push(line),
        },
      }),
    );
    expect(polls).toBe(3);
    expect(logged[0]).toMatch(
      /^wait lock {2}loop-1 is locked by run other-run \(pid \d+\); waiting/,
    );
    expect(result.checks.find((c) => c.name === "lock")).toMatchObject({
      status: "ok",
      detail: expect.stringMatching(/after waiting 1 min for run other-run$/),
    });
    expect(result.waits).toEqual([
      {
        name: "preflight.lock_wait",
        startedAt: new Date(NOW).toISOString(),
        durationS: 45,
      },
    ]);
    result.release();
  });

  it("records Docker's memory, warns under 8 GiB, refuses --parallel under 14 GiB, removes stopped loop-* containers no live run owns (never under --dry-run)", async () => {
    const small = fakeDocker(
      { memBytes: 7.75 * GIB },
      { stale: ["loop-old", "loop-sib-x"] },
    );
    // Not a dry run (a dry run removes nothing); cf: null still skips every network check.
    const result = await runPreflight(
      options(tempDir(), { docker: small.docker, dryRun: false }),
    );
    expect(result.ok).toBe(true);
    expect(
      result.checks.find((check) => check.name === "docker"),
    ).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("16 GiB"),
    });
    expect(
      result.checks.find((check) => check.name === "stale_containers")?.detail,
    ).toBe("removed loop-old, loop-sib-x");
    expect(small.removed).toEqual([["loop-old", "loop-sib-x"]]);
    result.release();
    const parallel = await runPreflight(
      options(tempDir(), {
        docker: fakeDocker({ memBytes: 7.75 * GIB }).docker,
        parallel: 2,
      }),
    );
    expect(parallel.ok).toBe(false);
    expect(parallel.checks.at(-1)?.detail).toMatch(/--parallel 2 needs 14 GiB/);
  });

  it("a container clock more than 60 s off fails; a missing image skips the clock check", async () => {
    const skewed = await runPreflight(
      options(tempDir(), { docker: fakeDocker({}, { skew: 90 }).docker }),
    );
    expect(skewed.ok).toBe(false);
    expect(skewed.checks.at(-1)).toMatchObject({
      name: "clock",
      status: "fail",
    });
    const unbuilt = await runPreflight(
      options(tempDir(), {
        docker: fakeDocker({}, { imageExists: false }).docker,
      }),
    );
    expect(unbuilt.ok).toBe(true);
    expect(
      unbuilt.checks.find((check) => check.name === "clock"),
    ).toMatchObject({
      status: "skip",
      detail: expect.stringContaining("not built yet"),
    });
    unbuilt.release();
  });

  it("without docker at all, the docker checks are skipped", async () => {
    const result = await runPreflight(options(tempDir(), { docker: null }));
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "docker")?.status).toBe(
      "skip",
    );
    result.release();
  });
});

describe("preflight (with a Cloudflare client)", () => {
  it("a rejected token is the fixture error that runs nothing", async () => {
    const cf = cfOf([
      {
        method: "GET",
        path: /^\/user\/tokens\/verify$/,
        reply: () => ({
          status: 400,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        }),
      },
    ]);
    const result = await runPreflight(
      options(tempDir(), { dryRun: false, cf }),
    );
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("fixture_token_rejected");
    expect(result.checks.at(-1)).toMatchObject({
      name: "token",
      status: "fail",
      detail: expect.stringContaining("token_rejected"),
    });
  });

  it("a token that sees two accounts fails the whoami gate; a missing zone is fixture_add_domain", async () => {
    const broad = await runPreflight(
      options(tempDir(), {
        dryRun: false,
        cf: cfOf(cfRoutes([], [ID, "f".repeat(32)])),
      }),
    );
    expect(broad.reasonCode).toBe("whoami_gate_failed");
    const noZone = await runPreflight(
      options(tempDir(), {
        dryRun: false,
        cf: cfOf(
          cfRoutes([
            { method: "GET", path: /^\/zones$/, reply: () => ({ result: [] }) },
          ]),
        ),
        fetch: docsFetch,
      }),
    );
    expect(noZone.reasonCode).toBe("fixture_add_domain");
    expect(noZone.checks.at(-1)?.detail).toMatch(/no zone everyapp-loop1.com/);
  });

  it("a good account passes and records the plan, the workers.dev state, the zone id and the docs URL", async () => {
    const result = await runPreflight(
      options(tempDir(), {
        dryRun: false,
        cf: cfOf(cfRoutes()),
        fetch: docsFetch,
      }),
    );
    expect(result.ok).toBe(true);
    const byName = Object.fromEntries(
      result.checks.map((check) => [check.name, check.status]),
    );
    expect(byName).toMatchObject({
      token: "ok",
      zone: "ok",
      plan: "ok",
      workers_subdomain: "ok",
      docs_url: "warn",
    });
    expect(result.fixtures).toMatchObject({
      plan: "paid",
      workers_subdomain: "first-run",
      zoneId: "z1",
      docs_url: { status: 302, final_url: "https://everyapp.com/" },
    });
    expect(result.fixtures.subscriptions).toHaveLength(1);
    result.release();
  });
});

describe("preflight helpers", () => {
  it("reads the Workers plan the way the CLI does", () => {
    expect(
      workersPlanOf([
        { state: "Paid", rate_plan: { public_name: "Workers Paid" } },
      ]),
    ).toBe("paid");
    expect(
      workersPlanOf([{ state: "Paid", rate_plan: { id: "workers_free" } }]),
    ).toBe("free");
    expect(
      workersPlanOf([
        { state: "Cancelled", rate_plan: { id: "workers_paid" } },
        { product: { name: "Pages" } },
      ]),
    ).toBe("unknown");
    expect(workersPlanOf([])).toBe("unknown");
  });

  it("tells an all-interfaces listener from a loopback one", () => {
    expect(
      isAllInterfaces("node 1 ben 20u IPv4 0 0t0 TCP 127.0.0.1:3000 (LISTEN)"),
    ).toBe(false);
    expect(isAllInterfaces("x 2 ben 21u IPv6 0 0t0 TCP *:8080 (LISTEN)")).toBe(
      true,
    );
    expect(
      isAllInterfaces("x 2 ben 21u IPv4 0 0t0 TCP 0.0.0.0:9000 (LISTEN)"),
    ).toBe(true);
    expect(
      isAllInterfaces("x 2 ben 21u IPv6 0 0t0 TCP [::]:9000 (LISTEN)"),
    ).toBe(true);
    expect(
      isAllInterfaces("x 2 ben 21u IPv6 0 0t0 TCP [::1]:9000 (LISTEN)"),
    ).toBe(false);
  });
});
