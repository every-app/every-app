import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCfApi, createFakeCfFetch, type FakeCfCall } from "./cf";
import type { Docker, DockerInfo } from "./docker";
import {
  answerMain,
  findingsMain,
  gcMain,
  recomputeMain,
  reportMain,
} from "./maintenance";
import { readRunRecord, RUN_FILES } from "./record";
import {
  containerName,
  DEFAULT_RUN_OPTIONS,
  describeRef,
  redactTree,
  runLoop,
  type RunDeps,
  type RunOptions,
  type SignalSource,
} from "./run";
import { FakeSandbox, type FakeExecAnswer, type FakeExecCall } from "./sandbox";
import { capture, createFakeSpawn, spawnProcess, type Spawn } from "./spawn";
import { createRedactor } from "./redact";
import { acquireAccountLock } from "./lock";
import { markerTitle } from "./teardownStep";
import type { FetchLike, HarnessAdapter, NormalizedEvent } from "./types";

const ID = "0123456789abcdef0123456789abcdef";
const ZONE = "everyapp-loop1.com";
const TOKEN = "fake-token-abcdefghijklmnopqrstuv";
const PROVIDER_KEY = "sk-ant-fake-provider-key-0123456789";
const ORIGIN = `https://apps.${ZONE}`;
const APP_HOST = `hello.apps.${ZONE}`;
const EST = `est_${"b".repeat(43)}`;
const COOKIE = "better-auth.session_token=abc; Path=/; HttpOnly";
const GIB = 1024 ** 3;

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A git repository with the three things describeRef looks for, one commit. */
async function makeRepo(
  options: { seam: boolean } = { seam: true },
): Promise<string> {
  const repo = tempDir("loop-run-repo-");
  const git = (args: string[]) =>
    capture(spawnProcess, "git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "loop@example.com"]);
  await git(["config", "user.name", "loop"]);
  fs.mkdirSync(path.join(repo, "packages/cli/src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "landing-page/content/agent"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repo, "packages/cli/package.json"),
    '{"name":"everyapp","version":"0.3.0"}\n',
  );
  fs.writeFileSync(
    path.join(repo, "packages/cli/src/eventLog.ts"),
    options.seam
      ? 'const name = "EVERYAPP_EVENT_LOG";\n'
      : "const name = 'nothing';\n",
  );
  fs.writeFileSync(
    path.join(repo, "landing-page/content/agent/index.md"),
    "# agent docs\n",
  );
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "fixture"]);
  return repo;
}

function makeConfigDir(): string {
  const dir = tempDir("loop-run-config-");
  fs.writeFileSync(
    path.join(dir, "accounts.json"),
    JSON.stringify({
      accounts: [
        {
          name: "loop-1",
          accountId: ID,
          zone: ZONE,
          email: `owner@${ZONE}`,
          token: TOKEN,
        },
      ],
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(dir, "providers.env"),
    `ANTHROPIC_API_KEY=${PROVIDER_KEY}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(dir, `confirm-${ID}`),
    `delete everything in ${ID}\n`,
    { mode: 0o600 },
  );
  return dir;
}

const cliEvent = (event: Record<string, unknown>) =>
  JSON.stringify({ v: 1, ts: "2026-10-25T14:10:00.000Z", ...event });

const teardownDone = cliEvent({
  type: "done",
  data: {
    accountId: ID,
    removed: [],
    kept: [],
    plan: {
      accountId: ID,
      total: 0,
      workers: [],
      d1: [],
      kv: [],
      access: { applications: [], policy: null },
      email: [],
      certificates: [],
      dns: [],
      r2: [],
      hyperdrive: [],
      workflows: [],
    },
  },
});
const statusDone = (owner: string) =>
  cliEvent({
    type: "done",
    data: {
      claimed: true,
      owner: { email: owner },
      apps: [
        { id: "hello", status: "active", bound: true, hostname: APP_HOST },
      ],
      upToDate: true,
      fixes: [],
    },
  });

/** The event log lines `setup`, `create` and `deploy` write when everything goes right. */
function happyEventLog(): string[] {
  const t = (s: number) =>
    `2026-10-25T14:${String(10 + s).padStart(2, "0")}:00.000Z`;
  return [
    JSON.stringify({
      type: "invocation",
      pid: 11,
      ts: t(0),
      argv: [
        "node",
        "/work/every-app/packages/cli/dist/cli.js",
        "setup",
        "--domain",
        `apps.${ZONE}`,
        "--json",
      ],
      cwd: "/work/every-app",
      json: true,
      isatty: { stdin: false, stdout: false, stderr: false },
      ci: false,
    }),
    cliEvent({
      pid: 11,
      ts: t(1),
      type: "step",
      step: "setup.gateway",
      status: "start",
    }),
    cliEvent({
      pid: 11,
      ts: t(5),
      type: "step",
      step: "setup.gateway",
      status: "ok",
    }),
    cliEvent({
      pid: 11,
      ts: t(6),
      type: "action_required",
      action: "claim_owner",
      message: "Open this link",
      data: { url: `${ORIGIN}/setup#token=${EST}`, waiting: true },
    }),
    cliEvent({
      pid: 11,
      ts: t(7),
      type: "step",
      step: "setup.owner",
      status: "ok",
    }),
    cliEvent({ pid: 11, ts: t(8), type: "done", data: { gatewayUrl: ORIGIN } }),
    JSON.stringify({ type: "exit", pid: 11, ts: t(8), code: 0, ms: 480000 }),
    JSON.stringify({
      type: "invocation",
      pid: 12,
      ts: t(9),
      argv: ["node", "cli.js", "create", "hello", "--json"],
      cwd: "/work/every-app",
      json: true,
      isatty: { stdin: false, stdout: false, stderr: false },
      ci: false,
    }),
    cliEvent({ pid: 12, ts: t(10), type: "done", data: { appId: "hello" } }),
    JSON.stringify({ type: "exit", pid: 12, ts: t(10), code: 0, ms: 60000 }),
    JSON.stringify({
      type: "invocation",
      pid: 13,
      ts: t(11),
      argv: ["node", "cli.js", "deploy", "--json"],
      cwd: "/work/every-app/apps/hello",
      json: true,
      isatty: { stdin: false, stdout: false, stderr: false },
      ci: false,
    }),
    cliEvent({
      pid: 13,
      ts: t(13),
      type: "done",
      data: { url: `https://${APP_HOST}` },
    }),
    JSON.stringify({ type: "exit", pid: 13, ts: t(13), code: 0, ms: 120000 }),
  ];
}

const happyScriptLines = [
  "LOOP_CMD pnpm install",
  "LOOP_EXIT 0",
  `LOOP_CMD pnpm everyapp setup --domain apps.${ZONE} --json`,
  "LOOP_EXIT 0",
  "LOOP_CMD pnpm everyapp create hello --json",
  "LOOP_EXIT 0",
  "LOOP_CMD pnpm everyapp deploy --json",
  "LOOP_EXIT 0",
  `DONE ${ORIGIN}`,
];

/**
 * The event log of a `setup` whose Gateway build failed (run
 * 2026-10-24T07:36 on Linux): the install started, nothing was uploaded, the
 * CLI exited 1 with GATEWAY_BUILD_FAILED in its last second.
 */
function buildFailedEventLog(): string[] {
  const t = (s: number) =>
    `2026-10-25T14:10:${String(s).padStart(2, "0")}.000Z`;
  return [
    JSON.stringify({
      type: "invocation",
      pid: 41,
      ts: t(0),
      argv: ["node", "cli.js", "setup", "--domain", `apps.${ZONE}`, "--json"],
      cwd: "/work/every-app",
      json: true,
      isatty: { stdin: false, stdout: false, stderr: false },
      ci: false,
    }),
    cliEvent({
      pid: 41,
      ts: t(4),
      type: "step",
      step: "setup.gateway",
      status: "start",
      data: { change: "install", gatewayUrl: ORIGIN },
    }),
    cliEvent({
      pid: 41,
      ts: t(4),
      type: "step",
      step: "gateway.release",
      status: "start",
    }),
    cliEvent({
      pid: 41,
      ts: t(18),
      type: "error",
      code: "GATEWAY_BUILD_FAILED",
      message:
        "Building the Gateway failed\npnpm run build:release exited with code 1",
      retryable: false,
      data: { command: "pnpm run build:release", exitCode: 1 },
    }),
    JSON.stringify({ type: "exit", pid: 41, ts: t(18), code: 1, ms: 18118 }),
  ];
}

/** What the control script prints when `setup` exits 1: it stops there. */
const buildFailedScriptLines = [
  "LOOP_CMD pnpm install",
  "LOOP_EXIT 0",
  `LOOP_CMD pnpm everyapp setup --domain apps.${ZONE} --json`,
  "LOOP_EXIT 1",
  "BLOCKED: setup exited 1",
];

/** No Gateway at the origin: every probe of it fails at DNS, as the verifier saw it from outside. */
function unreachableGateway(): Record<string, (init: RequestInit) => Response> {
  const noAddress = (): Response => {
    throw new TypeError(
      `apps.${ZONE} has no address at its zone's nameservers.`,
    );
  };
  return {
    [`GET ${ORIGIN}/sign-in`]: noAddress,
    [`POST ${ORIGIN}/api/setup/claim`]: noAddress,
    [`GET ${ORIGIN}/mcp`]: noAddress,
    [`POST ${ORIGIN}/api/auth/sign-in/email`]: noAddress,
  };
}

/** `everyapp status --json` in the verifier's sibling when nothing is installed. */
const gatewayNotFoundStatus = (
  call: FakeExecCall,
): FakeExecAnswer | undefined =>
  call.argv.join(" ").includes("everyapp status")
    ? {
        code: 1,
        stdout: [
          cliEvent({
            type: "error",
            code: "GATEWAY_NOT_FOUND",
            message: "No Gateway in this account",
            retryable: false,
          }),
        ],
      }
    : undefined;

interface World {
  deps: RunDeps;
  sandbox: FakeSandbox;
  cfCalls: FakeCfCall[];
  /** The account's KV namespaces as the fake holds them: created by POST, gone on DELETE. */
  kv: Array<{ id: string; title: string }>;
  gatewayCalls: string[];
  /** Execs and gateway calls in the order they happened. */
  timeline: string[];
  logs: string[];
  configDir: string;
  runsRoot: string;
}

function makeWorld(
  repo: string,
  script: {
    eventLog: string[];
    harnessLines: string[];
    harnessExit?: number;
    statusOwner?: string;
    gateway?: Record<string, (init: RequestInit) => Response>;
    /** Answers an exec before the defaults do (a harness other than the control script). */
    exec?: (
      call: FakeExecCall,
      sandbox: FakeSandbox,
    ) => FakeExecAnswer | undefined;
    /** Rows the fake D1 returns for the claimer's SELECT on owner_setup_tokens. */
    d1Rows?: Array<Record<string, unknown>>;
    /** KV namespace titles already in the account (another run's marker, say). */
    kv?: string[];
  },
): World {
  const configDir = makeConfigDir();
  const kv = (script.kv ?? []).map((title, i) => ({ id: `kv-${i}`, title }));
  const runsRoot = path.join(configDir, "runs");
  const logs: string[] = [];
  const timeline: string[] = [];
  const sandbox: FakeSandbox = new FakeSandbox(
    (call: FakeExecCall): FakeExecAnswer | undefined => {
      const argv = call.argv.join(" ");
      timeline.push(`exec ${argv}`);
      const custom: FakeExecAnswer | undefined = script.exec?.(call, sandbox);
      if (custom) return custom;
      if (argv.includes("everyapp teardown")) return { stdout: [teardownDone] };
      if (argv.includes("everyapp status"))
        return { stdout: [statusDone(script.statusOwner ?? `owner@${ZONE}`)] };
      if (argv === "bash --version")
        return { stdout: ["GNU bash, version 5.2.15"] };
      if (argv.startsWith("bash -c tr"))
        return { stdout: ["TERM=dumb", "SHELL=/bin/bash"] };
      if (argv === "bash /loop/script.sh") {
        // The CLI writes its event log while the script runs; the tail delivers it as it is written.
        for (const line of script.eventLog)
          sandbox.pushTail("/loop/everyapp-events.ndjson", line);
        return { stdout: script.harnessLines, code: script.harnessExit ?? 0 };
      }
      return { code: 0 };
    },
  );
  const info: DockerInfo = {
    engine: "29.8.2",
    memBytes: 16 * GIB,
    ncpu: 18,
    os: "linux",
    arch: "aarch64",
  };
  const docker: Docker = {
    binary: "/fake/docker",
    info: async () => info,
    listContainers: async () => [],
    removeContainers: async () => undefined,
    imageExists: async () => true,
    imageSizeBytes: async () => 7_710_000_000,
    build: async () => ({ ms: 1 }),
    run: async () => ({ code: 0, stdout: [], stderr: [] }),
    clockSkewSeconds: async () => 0.2,
    memoryMiB: async () => 1500,
    sandbox,
  };
  const cf = createFakeCfFetch([
    {
      method: "GET",
      path: /^\/user\/tokens\/verify$/,
      reply: () => ({ result: { id: "t", status: "active" } }),
    },
    {
      method: "GET",
      path: /^\/accounts$/,
      reply: () => ({ result: [{ id: ID, name: "Loop 1" }] }),
    },
    {
      method: "GET",
      path: /^\/zones$/,
      reply: () => ({ result: [{ id: "z1", name: ZONE, status: "active" }] }),
    },
    {
      method: "GET",
      path: new RegExp(`^/accounts/${ID}/subscriptions$`),
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
      path: new RegExp(`^/accounts/${ID}/workers/subdomain$`),
      reply: () => ({
        status: 404,
        success: false,
        errors: [{ code: 10007, message: "no subdomain" }],
      }),
    },
    {
      method: "PUT",
      path: new RegExp(`^/accounts/${ID}/workers/subdomain$`),
      reply: (_m, call) => ({
        result: { subdomain: (call.body as { subdomain: string }).subdomain },
      }),
    },
    {
      method: "GET",
      path: new RegExp(`^/accounts/${ID}/d1/database$`),
      reply: () => ({ result: [{ uuid: "db-gw", name: "every-app-gateway" }] }),
    },
    {
      method: "POST",
      path: new RegExp(`^/accounts/${ID}/d1/database/db-gw/query$`),
      reply: (_m, call) => ({
        result: [
          {
            results: String((call.body as { sql: string }).sql).startsWith(
              "SELECT id, expires_at",
            )
              ? (script.d1Rows ?? [])
              : [],
            success: true,
          },
        ],
      }),
    },
    {
      method: "GET",
      path: new RegExp(`^/accounts/${ID}/storage/kv/namespaces$`),
      reply: () => ({ result: [...kv] }),
    },
    {
      method: "POST",
      path: new RegExp(`^/accounts/${ID}/storage/kv/namespaces$`),
      reply: (_m, call) => {
        const row = {
          id: `kv-${kv.length}`,
          title: (call.body as { title: string }).title,
        };
        kv.push(row);
        return { result: row };
      },
    },
    {
      method: "DELETE",
      path: new RegExp(`^/accounts/${ID}/storage/kv/namespaces/([^/]+)$`),
      reply: (match) => {
        const index = kv.findIndex((row) => row.id === match[1]);
        if (index === -1) return { status: 404, success: false };
        kv.splice(index, 1);
        return { result: null };
      },
    },
    {
      method: "GET",
      path: /^\/zones\/z1\/dns_records$/,
      reply: () => ({ result: [] }),
    },
  ]);
  const gatewayCalls: string[] = [];
  const routes: Record<string, (init: RequestInit) => Response> = {
    [`POST ${ORIGIN}/api/setup/claim`]: (init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (!headers["origin"])
        return new Response('{"error":"ORIGIN_NOT_ALLOWED"}', { status: 403 });
      const body = JSON.parse(String(init.body)) as { token: string };
      return body.token === EST
        ? new Response('{"ok":true,"organizationId":"org1"}', { status: 200 })
        : new Response('{"error":"INVALID_OR_EXPIRED_SETUP_LINK"}', {
            status: 403,
          });
    },
    [`GET ${ORIGIN}/sign-in`]: () =>
      new Response("<html>sign in</html>", { status: 200 }),
    [`GET ${ORIGIN}/mcp`]: () =>
      new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="OAuth", resource_metadata="https://apps.example.com/.well-known/oauth-protected-resource"',
        },
      }),
    [`POST ${ORIGIN}/api/auth/sign-in/email`]: () =>
      new Response('{"token":"x"}', {
        status: 200,
        headers: { "set-cookie": COOKIE },
      }),
    [`GET ${ORIGIN}/api/auth/get-session`]: () =>
      new Response(JSON.stringify({ user: { email: `owner@${ZONE}` } }), {
        status: 200,
      }),
    [`GET https://${APP_HOST}/`]: (init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (headers["cookie"])
        // The starter's server-rendered head, as a fetch with the owner cookie gets it (the
        // index heading is withheld while the route's query loads).
        return new Response(
          '<html><head><meta name="apple-mobile-web-app-capable" content="yes"/></head><body></body></html>',
          { status: 200 },
        );
      if (headers["accept"] === "text/html")
        return new Response("", {
          status: 302,
          headers: { location: `${ORIGIN}/sign-in?return_to=x` },
        });
      return new Response('{"error":"unauthenticated"}', { status: 401 });
    },
    ...script.gateway,
  };
  const gatewayFetch: FetchLike = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    gatewayCalls.push(key);
    timeline.push(`gateway ${key}`);
    if (/^GET https:\/\/nope-[0-9a-f]+\.apps\./.test(key))
      return new Response('{"error":"unknown_app_host"}', { status: 404 });
    const route = routes[key];
    if (!route) return new Response("no route", { status: 599 });
    return route(init);
  };
  const fakeHost = createFakeSpawn(() => ({
    stdout: [
      "COMMAND PID",
      "node 1 ben 20u IPv4 0 0t0 TCP 127.0.0.1:3000 (LISTEN)",
    ],
  }));
  const spawn: Spawn = (bin, args, options) =>
    bin === "git"
      ? spawnProcess(bin, args, options)
      : fakeHost.spawn(bin, args, options);
  const deps: RunDeps = {
    configDir,
    runsRoot,
    repoRoot: repo,
    dockerfile: path.join(repo, "Dockerfile.fake"),
    docker,
    spawn,
    createCf: (account) =>
      createCfApi({
        token: account.token,
        accountId: account.accountId,
        fetch: cf.fetch,
      }),
    createFetch: () => gatewayFetch,
    docsFetch: async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://everyapp.com/" },
      }),
    now: () => Date.now(),
    sleep: async () => undefined,
    log: (line) => logs.push(line),
    statsIntervalMs: 5,
    caffeinate: false,
  };
  fs.writeFileSync(deps.dockerfile, "FROM node:22\n");
  return {
    deps,
    sandbox,
    cfCalls: cf.calls,
    kv,
    gatewayCalls,
    timeline,
    logs,
    configDir,
    runsRoot,
  };
}

/** A claim route that takes any est_ token (the D1-side claimer mints its own). */
const anyTokenClaim = (init: RequestInit): Response => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (!headers["origin"])
    return new Response('{"error":"ORIGIN_NOT_ALLOWED"}', { status: 403 });
  const body = JSON.parse(String(init.body)) as { token: string };
  return /^est_[A-Za-z0-9_-]{20,}$/.test(body.token)
    ? new Response('{"ok":true,"organizationId":"org1"}', { status: 200 })
    : new Response('{"error":"INVALID_OR_EXPIRED_SETUP_LINK"}', {
        status: 403,
      });
};

/**
 * A two-process harness like Claude Code's `-p` runs: `TEXT`/`RESULT` lines
 * out, resumed with `--resume <session>`. The CLI event log is pushed by the
 * world's exec hook, as the CLI would write it while the harness runs.
 */
function fakeTurnsAdapter(): HarnessAdapter {
  return {
    name: "claude",
    version: "x",
    status: "measured",
    providerVar: "ANTHROPIC_API_KEY",
    defaultModel: "m",
    signal: {
      toolCalls: "full",
      toolOutput: "full",
      exitCodes: true,
      cost: "harness",
      resume: "native",
    },
    permissionBypass: true,
    command: () => ({ argv: ["fake", "--turn", "1"] }),
    resume: (sessionId, replyPath) =>
      sessionId ? { argv: ["fake", "--resume", sessionId, replyPath] } : null,
    normalize: (line, _stream, receivedAt): NormalizedEvent[] => {
      if (line.startsWith("TEXT "))
        return [
          {
            receivedAt,
            kind: "assistant_text",
            text: line.slice(5),
            sessionId: "s1",
            raw: line,
          },
        ];
      if (line === "RESULT")
        return [
          { receivedAt, kind: "result", text: "", sessionId: "s1", raw: line },
        ];
      return [];
    },
    collectPaths: [],
    fixture: null,
  };
}

/** A clock that jumps a minute per read: the verifier's retry windows close at once when a probe keeps failing. */
const advancingClock = () => {
  let t = Date.now();
  return () => (t += 60_000);
};

const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  ...DEFAULT_RUN_OPTIONS,
  harness: "script",
  account: "loop-1",
  ...overrides,
});

/** Every file under the run directory, read as text. */
function runFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else out[path.relative(dir, file)] = fs.readFileSync(file, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("describeRef", () => {
  it("names the commit, the CLI version, the agent docs and the event-log seam", async () => {
    const repo = await makeRepo();
    const described = await describeRef(spawnProcess, repo, "HEAD");
    expect(described.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(described).toMatchObject({
      cliVersion: "0.3.0",
      agentDocs: true,
      eventLogSeam: true,
    });
    const noSeam = await describeRef(
      spawnProcess,
      await makeRepo({ seam: false }),
      "HEAD",
    );
    expect(noSeam.eventLogSeam).toBe(false);
  });
});

describe("redactTree", () => {
  it("rewrites every file under a collected directory through the redactor", () => {
    const dir = tempDir("loop-redact-");
    fs.mkdirSync(path.join(dir, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a/b/env.txt"), `TOKEN=${TOKEN}\nOK=1\n`);
    fs.writeFileSync(path.join(dir, "a/plain.txt"), "nothing here\n");
    const redactor = createRedactor([{ name: "cf_token", value: TOKEN }]);
    expect(redactTree(dir, redactor)).toBe(2);
    expect(fs.readFileSync(path.join(dir, "a/b/env.txt"), "utf8")).toBe(
      "TOKEN=[REDACTED:cf_token]\nOK=1\n",
    );
    expect(redactor.exposure().cf_token).toBe(1);
  });
});

describe("runLoop", () => {
  it("--dry-run goes through preflight with the stub account when accounts.json is absent and makes no call", async () => {
    const repo = await makeRepo();
    const world = makeWorld(repo, { eventLog: [], harnessLines: [] });
    fs.rmSync(path.join(world.configDir, "accounts.json"));
    const outcome = await runLoop(
      options({ account: "stub", dryRun: true }),
      world.deps,
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.record).toBeNull();
    expect(world.logs.join("\n")).toContain("using the stub account");
    expect(world.logs.join("\n")).toContain("preflight ok (dry run");
    expect(world.logs.join("\n")).toContain("skip token");
    expect(world.cfCalls).toEqual([]);
    expect(world.gatewayCalls).toEqual([]);
    expect(world.sandbox.created).toEqual([]);
    expect(fs.existsSync(world.runsRoot)).toBe(false);
  });

  it("runs the control harness end to end on fakes: wipe, sandbox, claim from the event log, verify, wipe, a passing record with no secret in it", async () => {
    const repo = await makeRepo();
    const world = makeWorld(repo, {
      eventLog: happyEventLog(),
      harnessLines: happyScriptLines,
    });
    const outcome = await runLoop(options(), world.deps);
    const text = world.logs.join("\n");
    expect(outcome.exitCode, text).toBe(0);
    const record = outcome.record!;
    expect(record.verdict).toEqual({
      value: "pass",
      reasonCode: null,
      falseDone: false,
      tainted: false,
      shortcut: false,
      reportedUrl: ORIGIN,
    });
    expect(record.terminal_reason).toBe("completed");
    expect(record.harness).toMatchObject({
      name: "script",
      version: "bash",
      mode: null,
    });
    expect(record.steps.claim).toMatchObject({
      how: "event-log",
      linkEmittedAt: "2026-10-25T14:16:00.000Z",
      linkSurfacedToPerson: false,
    });
    expect(record.steps.setup).toEqual({ status: "done", reruns: 0 });
    expect(record.steps.app).toEqual({
      by: "harness",
      id: "hello",
      url: `https://${APP_HOST}`,
    });
    expect(record.everyappCommands.map((c) => c.argv[0])).toEqual([
      "setup",
      "create",
      "deploy",
    ]);
    expect(record.everyappCommands[0]).toMatchObject({
      json: true,
      ci: false,
      exit: 0,
      ms: 480000,
      events: { actions: ["claim_owner"] },
    });
    expect(record.verify.rows).toEqual({
      G1: "pass",
      G2: "pass",
      G3: "pass",
      O1: "pass",
      A1: "pass",
      A2: "pass",
      A3: "pass",
      S1: "pass",
      T1: "pass",
      X1: "skipped",
    });
    expect(record.verify.phaseReached).toBe("app-live");
    expect(record.deviations).toEqual([
      "checkout_preplaced",
      "api_token_auth",
      "event_log",
      "claim_immediate",
    ]);
    expect(record.fixtures).toMatchObject({
      workers_subdomain: "first-run",
      cert_packs: "deleted",
      preRunPlanTotal: 0,
      docs_url: { status: 302 },
    });
    expect(record.cli).toEqual({
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      version: "0.3.0",
    });
    expect(record.agentDocs).toEqual({
      present: true,
      commit: record.cli.commit,
    });
    expect(record.toolEnv).toEqual({
      CI: null,
      TERM: "dumb",
      SHELL: "/bin/bash",
    });
    expect(record.phases.map((p) => p.name)).toEqual([
      "install",
      "setup",
      "setup.gateway",
      "setup.owner",
      "create",
      "deploy",
      "teardown.before",
      "harness",
      "verify",
      "teardown.after",
    ]);
    expect(record.handoffs.exercised).toEqual(["claim_owner"]);
    expect(record.interventions).toEqual([]);
    expect(record.substrate).toMatchObject({
      kind: "docker",
      engine: "29.8.2",
      vmMemoryGiB: 16,
      statsPeakMiB: 1500,
    });
    expect(record.secret_exposure).toEqual({
      cf_token: 0,
      provider_key: 0,
      est_link: 1,
      owner_password: 0,
      bearer: 0,
    });

    // The container: created with exactly the secrets, the bundle and the prompt in, the script in, destroyed.
    const main = world.sandbox.created.find(
      (spec) => spec.name === containerName(outcome.runId),
    )!;
    expect(Object.keys(main.env).sort()).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "EVERYAPP_EVENT_LOG",
    ]);
    expect(main).toMatchObject({
      cpus: 4,
      memory: "6g",
      user: "dev",
      workdir: "/work",
      image: expect.stringMatching(/^everyapp-loop:/),
    });
    expect(
      world.sandbox.copiedIn
        .filter((c) => c.name === main.name)
        .map((c) => c.sandboxPath),
    ).toEqual(["/loop/launch.bundle", "/loop/prompt.txt", "/loop/script.sh"]);
    expect(world.sandbox.destroyed).toContain(main.name);
    const harnessExec = world.sandbox.execs.find(
      (e) => e.argv.join(" ") === "bash /loop/script.sh",
    )!;
    expect(harnessExec.options.cwd).toBe("/work/every-app");
    // Two sibling containers for the teardown (allowlist set), one for the verifier (not set).
    const siblings = world.sandbox.created.filter((spec) =>
      spec.name.startsWith("loop-sib-"),
    );
    expect(siblings.map((s) => "EVERYAPP_TEST_ACCOUNTS" in s.env)).toEqual([
      true,
      false,
      true,
    ]);
    expect(
      world.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp teardown"),
      ).length,
    ).toBe(2);
    // The marker went in, the links were expired through D1, the claim carried the Origin header.
    expect(
      world.cfCalls.find(
        (c) => c.method === "POST" && c.path.endsWith("/storage/kv/namespaces"),
      )?.body,
    ).toEqual({ title: `every-loop-run-${outcome.runId}` });
    expect(
      world.cfCalls.some(
        (c) =>
          c.path.endsWith("/query") &&
          String((c.body as { sql: string }).sql).includes("expires_at = 0"),
      ),
    ).toBe(true);
    expect(
      world.gatewayCalls.filter((c) => c === `POST ${ORIGIN}/api/setup/claim`)
        .length,
    ).toBeGreaterThanOrEqual(2);

    // The run directory: every artifact, mode 600, and never the token, the key, the password or the link.
    const dir = path.join(world.runsRoot, outcome.runId);
    const files = runFiles(dir);
    for (const name of [
      RUN_FILES.record,
      RUN_FILES.events,
      RUN_FILES.eventLog,
      RUN_FILES.verify,
      RUN_FILES.inventoryBefore,
      RUN_FILES.inventoryAfter,
      RUN_FILES.diff,
      RUN_FILES.prompt,
      RUN_FILES.assembleInput,
      RUN_FILES.decideInput,
      RUN_FILES.harnessRaw,
      RUN_FILES.stats,
    ])
      expect(Object.keys(files), name).toContain(name);
    expect(fs.statSync(path.join(dir, RUN_FILES.record)).mode & 0o077).toBe(0);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
    for (const [name, content] of Object.entries(files)) {
      expect(content, name).not.toContain(TOKEN);
      expect(content, name).not.toContain(PROVIDER_KEY);
      expect(content, name).not.toContain(EST);
    }
    expect(files[RUN_FILES.eventLog]).toContain("[REDACTED:est_link]");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EST);
    expect(readRunRecord(world.runsRoot, outcome.runId).runId).toBe(
      outcome.runId,
    );
    expect(text).toContain("pass: phase app-live");
  });

  it("a fixture action_required (upgrade_workers_paid) is fail-infra and the harness is not answered", async () => {
    const repo = await makeRepo();
    const t = "2026-10-25T14:10:00.000Z";
    const world = makeWorld(repo, {
      eventLog: [
        JSON.stringify({
          type: "invocation",
          pid: 21,
          ts: t,
          argv: [
            "node",
            "cli.js",
            "setup",
            "--domain",
            `apps.${ZONE}`,
            "--json",
          ],
          cwd: "/work/every-app",
          json: true,
          isatty: { stdin: false, stdout: false, stderr: false },
          ci: false,
        }),
        cliEvent({
          pid: 21,
          type: "action_required",
          action: "upgrade_workers_paid",
          message: "Workers Paid is needed",
          data: { url: "https://dash.cloudflare.com/" },
        }),
        JSON.stringify({ type: "exit", pid: 21, ts: t, code: 2, ms: 9000 }),
      ],
      harnessLines: [
        "LOOP_CMD pnpm install",
        "LOOP_EXIT 0",
        `LOOP_CMD pnpm everyapp setup --domain apps.${ZONE} --json`,
        "LOOP_EXIT 2",
        "BLOCKED: setup stopped for a person three times",
      ],
      harnessExit: 1,
      gateway: {
        [`GET ${ORIGIN}/sign-in`]: () => new Response("", { status: 530 }),
      },
    });
    const outcome = await runLoop(options(), {
      ...world.deps,
      now: advancingClock(),
    });
    const record = outcome.record!;
    expect(outcome.exitCode).toBe(1);
    expect(record.verdict.value).toBe("fail-infra");
    expect(record.verdict.reasonCode).toBe("fixture_upgrade_workers_paid");
    expect(record.terminal_reason).toBe("fixture_error");
    expect(record.steps.setup).toEqual({
      status: "action_required",
      reruns: 0,
    });
    expect(record.scriptedUserTurns).toEqual([]);
    expect(record.steps.claim.how).toBe("none");
    expect(world.sandbox.destroyed.length).toBeGreaterThan(0);
    expect(
      world.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp teardown"),
      ).length,
    ).toBe(2);
  });

  it("a pre-run wipe refused on another live run's marker is fail-infra teardown_refused: nothing installed, no verifier, the command that forces named", async () => {
    const repo = await makeRepo();
    // Another lane's run holds a live lock (another account's, on this host) and its marker is in
    // this account: the one shape of marker the wipe still refuses on.
    const otherRunId = "2026-10-25T13:00-claude-other1";
    const world = makeWorld(repo, {
      eventLog: [],
      harnessLines: [],
      kv: [markerTitle(otherRunId), "every-app-gateway-OAUTH_KV"],
    });
    const otherLane = acquireAccountLock(
      path.join(world.configDir, "locks"),
      "fedcba9876543210fedcba9876543210",
      otherRunId,
    );
    try {
      const outcome = await runLoop(options(), world.deps);
      const record = outcome.record!;
      expect(outcome.exitCode).toBe(1);
      expect(record.verdict).toMatchObject({
        value: "fail-infra",
        reasonCode: "teardown_refused",
        falseDone: false,
      });
      expect(record.terminal_reason).toBe("teardown_failed");
      expect(record.errors).toEqual([
        {
          code: "teardown_marker_refused",
          step: "teardown.before",
          source: "infra",
          message: expect.stringContaining(
            `Another run left its marker in the account: ${markerTitle(otherRunId)} still holds the lock here; if that run is really gone, \`pnpm loop teardown --account loop-1 --force\` wipes anyway.`,
          ),
        },
      ]);
      expect(record.verify.phaseReached).toBe("none");
      // Refused before the dry run: no everyapp ran, no marker went in, no harness container, no verifier.
      expect(
        world.sandbox.execs.filter((e) => e.argv.includes("everyapp")),
      ).toEqual([]);
      expect(world.kv.map((row) => row.title)).toEqual([
        markerTitle(otherRunId),
        "every-app-gateway-OAUTH_KV",
      ]);
      expect(
        world.sandbox.created.some(
          (spec) => spec.name === containerName(outcome.runId),
        ),
      ).toBe(false);
      expect(world.gatewayCalls).toEqual([]);
      expect(world.sandbox.running).toEqual([]);
      expect(world.logs.join("\n")).toContain(
        "wipe before the run marker_refused",
      );
    } finally {
      otherLane.release();
    }
  });

  it("a marker left by a run whose lock died here (a SIGKILLed driver) is stale at any age: the next run takes the lock over and wipes without --force", async () => {
    const repo = await makeRepo();
    // The dead run's marker is 30 minutes old: young by the age rule, but its lock on this account
    // is a dead process's, which the next run's preflight takes over and remembers.
    const deadRunId = `${new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16)}-script-dead01`;
    const world = makeWorld(repo, {
      eventLog: happyEventLog(),
      harnessLines: happyScriptLines,
      kv: [markerTitle(deadRunId)],
    });
    const locks = path.join(world.configDir, "locks");
    const dead = acquireAccountLock(locks, ID, deadRunId);
    fs.writeFileSync(
      dead.file,
      JSON.stringify({ ...dead.info, pid: 2 ** 22 - 1 }),
    );
    const outcome = await runLoop(options(), world.deps);
    const text = world.logs.join("\n");
    expect(outcome.exitCode, text).toBe(0);
    expect(outcome.record!.verdict.value).toBe("pass");
    expect(text).not.toContain("marker_refused");
    // The dead run stays known after its lock file was replaced, and the wipe found the marker.
    expect(
      JSON.parse(fs.readFileSync(path.join(locks, `${ID}.state.json`), "utf8")),
    ).toMatchObject({ deadRunIds: [deadRunId] });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(world.runsRoot, outcome.runId, RUN_FILES.inventoryBefore),
          "utf8",
        ),
      ),
    ).toBeTruthy();
  });

  it("a pre-run wipe whose sibling fails (pnpm install exits 1) is fail-infra teardown_failed: nothing installed, no harness container, no verifier", async () => {
    const repo = await makeRepo();
    const world = makeWorld(repo, {
      eventLog: [],
      harnessLines: [],
      // Only a sibling runs `pnpm install` as an exec of its own (the control script's is a line it prints).
      exec: (call) =>
        call.argv.join(" ") === "pnpm install"
          ? { code: 1, stderr: ["ERR_PNPM_NO_SCRIPT_OR_WHATEVER"] }
          : undefined,
    });
    const outcome = await runLoop(options(), world.deps);
    const record = outcome.record!;
    expect(outcome.exitCode).toBe(1);
    expect(record.verdict).toMatchObject({
      value: "fail-infra",
      reasonCode: "teardown_failed",
      falseDone: false,
    });
    expect(record.terminal_reason).toBe("teardown_failed");
    expect(record.errors).toEqual([
      {
        code: "teardown_sibling_failed",
        step: "teardown.before",
        source: "infra",
        message: "pnpm install failed in the sibling",
      },
    ]);
    expect(record.verify.phaseReached).toBe("none");
    expect(record.phases.map((p) => p.name)).not.toContain("verify");
    expect(
      world.sandbox.execs.filter((e) => e.argv.includes("everyapp")),
    ).toEqual([]);
    expect(world.kv).toEqual([]);
    expect(
      world.sandbox.created.some(
        (spec) => spec.name === containerName(outcome.runId),
      ),
    ).toBe(false);
    expect(world.sandbox.running).toEqual([]);
    expect(world.logs.join("\n")).toContain(
      "wipe before the run sibling_failed",
    );
  });

  it("SIGTERM mid-harness: cleanup removes the container, the run's marker and every sibling, wipes, writes a killed record, and only then exits 130", async () => {
    const repo = await makeRepo();
    let onSignal: ((signal: NodeJS.Signals) => void) | null = null;
    const exits: number[] = [];
    const world = makeWorld(repo, {
      eventLog: [],
      harnessLines: [],
      exec: (call) => {
        if (call.argv.join(" ") !== "bash /loop/script.sh") return undefined;
        // The kill arrives while the harness runs; `docker rm -f` of its container ends the exec.
        setTimeout(() => onSignal?.("SIGTERM"), 0);
        return { hang: true };
      },
    });
    // What the world looks like at the moment of exit(130): the proof that nothing exits before
    // cleanup is done, whatever the assertions after runLoop returns would say.
    const atExit: Array<{
      running: number;
      marker: boolean;
      record: boolean;
      lock: boolean;
    }> = [];
    const signals: SignalSource = {
      on: (handler) => {
        onSignal = handler;
        return () => {
          onSignal = null;
        };
      },
      exit: (code) => {
        exits.push(code);
        atExit.push({
          running: world.sandbox.running.length,
          marker: world.kv.some((row) =>
            row.title.startsWith("every-loop-run-"),
          ),
          record:
            fs.existsSync(world.runsRoot) &&
            fs
              .readdirSync(world.runsRoot)
              .some((dir) =>
                fs.existsSync(path.join(world.runsRoot, dir, RUN_FILES.record)),
              ),
          lock: fs.existsSync(
            path.join(world.configDir, "locks", `${ID}.json`),
          ),
        });
      },
    };
    const outcome = await runLoop(options(), { ...world.deps, signals });
    const text = world.logs.join("\n");
    expect(exits, text).toEqual([130]);
    expect(atExit).toEqual([
      { running: 0, marker: false, record: true, lock: false },
    ]);
    const record = outcome.record!;
    expect(record.terminal_reason).toBe("killed");
    expect(record.verdict).toMatchObject({
      value: "fail-infra",
      reasonCode: "killed",
    });
    expect(record.errors[0]).toMatchObject({ code: "killed", source: "loop" });
    // The marker was created, then removed by cleanup, and the post-run wipe was not refused on it.
    expect(
      world.cfCalls.some(
        (c) => c.method === "POST" && c.path.endsWith("/storage/kv/namespaces"),
      ),
    ).toBe(true);
    expect(
      world.cfCalls.filter((c) => c.method === "DELETE").map((c) => c.path),
    ).toEqual([`/accounts/${ID}/storage/kv/namespaces/kv-0`]);
    expect(
      world.kv.filter((row) => row.title.startsWith("every-loop-run-")),
    ).toEqual([]);
    expect(
      world.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp teardown"),
      ),
    ).toHaveLength(2);
    expect(text).not.toContain("teardown after the run failed");
    // No verifier after a kill, and nothing left running: not the harness's container, not a sibling.
    expect(
      world.sandbox.execs.some((e) =>
        e.argv.join(" ").includes("everyapp status"),
      ),
    ).toBe(false);
    expect(record.phases.map((p) => p.name)).not.toContain("verify");
    expect(world.sandbox.running).toEqual([]);
    expect(world.sandbox.destroyed).toContain(containerName(outcome.runId));
    // The record exists on disk and the lock is released.
    expect(
      fs.existsSync(path.join(world.runsRoot, outcome.runId, RUN_FILES.record)),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(world.configDir, "locks", `${ID}.json`)),
    ).toBe(false);
    expect(text).toContain("SIGTERM: cleaning up");
    expect(text).toContain("run marker removed");
  });

  it("a signal during the post-run wipe leaves a finished run as it was: the wipe completes, the verdict stays pass, then exit 130", async () => {
    const repo = await makeRepo();
    let onSignal: ((signal: NodeJS.Signals) => void) | null = null;
    const exits: number[] = [];
    let teardowns = 0;
    const world = makeWorld(repo, {
      eventLog: happyEventLog(),
      harnessLines: happyScriptLines,
      exec: (call) => {
        if (!call.argv.join(" ").includes("everyapp teardown"))
          return undefined;
        teardowns += 1;
        // The wipe before the run is one dry run (the account is empty); the next teardown exec is
        // the post-run wipe's, already inside cleanup.
        if (teardowns === 2) onSignal?.("SIGTERM");
        return undefined;
      },
    });
    const signals: SignalSource = {
      on: (handler) => {
        onSignal = handler;
        return () => {
          onSignal = null;
        };
      },
      exit: (code) => {
        exits.push(code);
      },
    };
    const outcome = await runLoop(options(), { ...world.deps, signals });
    const text = world.logs.join("\n");
    expect(exits, text).toEqual([130]);
    const record = outcome.record!;
    expect(record.terminal_reason).toBe("completed");
    expect(record.verdict.value).toBe("pass");
    expect(record.errors.map((e) => e.code)).not.toContain("killed");
    expect(
      world.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp teardown"),
      ),
    ).toHaveLength(2);
    expect(text).toContain(
      "SIGTERM during the cleanup after the run: the record keeps what the run was",
    );
    expect(text).not.toContain("teardown after the run failed");
    expect(world.sandbox.running).toEqual([]);
  });

  it("a signal while the harness's container is being created still removes it, the marker and the siblings: nothing outlives the driver", async () => {
    const repo = await makeRepo();
    let onSignal: ((signal: NodeJS.Signals) => void) | null = null;
    const exits: number[] = [];
    const world = makeWorld(repo, { eventLog: [], harnessLines: [] });
    const create = world.sandbox.create.bind(world.sandbox);
    world.sandbox.create = async (spec) => {
      // The kill lands while `docker create` of the harness's container (the one with the event
      // log in its env) is in flight: cleanup's first pass finds no handle to remove.
      if (spec.env["EVERYAPP_EVENT_LOG"]) onSignal?.("SIGTERM");
      return create(spec);
    };
    const signals: SignalSource = {
      on: (handler) => {
        onSignal = handler;
        return () => {
          onSignal = null;
        };
      },
      exit: (code) => {
        exits.push(code);
      },
    };
    const outcome = await runLoop(options(), { ...world.deps, signals });
    const text = world.logs.join("\n");
    expect(exits, text).toEqual([130]);
    const record = outcome.record!;
    expect(record.terminal_reason).toBe("killed");
    expect(record.verdict).toMatchObject({
      value: "fail-infra",
      reasonCode: "killed",
    });
    const harness = world.sandbox.created.find(
      (spec) => spec.env["EVERYAPP_EVENT_LOG"],
    );
    expect(harness?.name).toBe(containerName(outcome.runId));
    expect(world.sandbox.destroyed).toContain(harness!.name);
    expect(world.sandbox.running).toEqual([]);
    // Never launched, never verified; the marker went and the account was wiped again.
    expect(
      world.sandbox.execs.some(
        (e) => e.argv.join(" ") === "bash /loop/script.sh",
      ),
    ).toBe(false);
    expect(
      world.sandbox.execs.some((e) =>
        e.argv.join(" ").includes("everyapp status"),
      ),
    ).toBe(false);
    expect(
      world.kv.filter((row) => row.title.startsWith("every-loop-run-")),
    ).toEqual([]);
    expect(
      world.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp teardown"),
      ),
    ).toHaveLength(2);
  });

  it("without the event-log seam in the commit under test, the log stays empty, the claim runs D1-side, the app comes from status --json, and the record is still a pass", async () => {
    const repo = await makeRepo({ seam: false });
    const world = makeWorld(repo, {
      // A CLI without the seam writes nothing to the event log.
      eventLog: [],
      harnessLines: happyScriptLines,
      d1Rows: [{ id: "row-1", expires_at: Date.now() + 86_400_000 }],
      gateway: { [`POST ${ORIGIN}/api/setup/claim`]: anyTokenClaim },
    });
    const outcome = await runLoop(options(), world.deps);
    const record = outcome.record!;
    const text = world.logs.join("\n");
    expect(record.deviations).toContain("d1_claim");
    expect(record.deviations).not.toContain("event_log");
    expect(text).toContain(
      "WARNING: the commit under test has no EVERYAPP_EVENT_LOG seam",
    );
    expect(
      world.cfCalls.some(
        (c) =>
          c.path.endsWith("/query") &&
          String((c.body as { sql: string }).sql).includes(
            "UPDATE owner_setup_tokens SET token_hash",
          ),
      ),
    ).toBe(true);
    expect(record.steps.claim.how, text).toBe("d1");
    expect(record.everyappCommands).toEqual([]);
    // The script's own tool calls say it deployed; status --json names the app; the verifier never deployed.
    expect(record.steps.app).toEqual({
      by: "harness",
      id: "hello",
      url: `https://${APP_HOST}`,
    });
    expect(
      world.sandbox.execs.some((e) =>
        e.argv.join(" ").includes("create hello"),
      ),
    ).toBe(false);
    expect(record.verdict.value, text).toBe("pass");
  });

  it("--claim-after turn-end claims when the turn that showed the link ends, before the next process starts, with no intervention", async () => {
    const repo = await makeRepo();
    const t = (s: number) =>
      `2026-10-25T14:${String(10 + s).padStart(2, "0")}:00.000Z`;
    const inv = (pid: number, ts: string, argv: string[], cwd: string) =>
      JSON.stringify({
        type: "invocation",
        pid,
        ts,
        argv: ["node", "cli.js", ...argv],
        cwd,
        json: true,
        isatty: { stdin: false, stdout: false, stderr: false },
        ci: false,
      });
    const exit = (pid: number, ts: string) =>
      JSON.stringify({ type: "exit", pid, ts, code: 0, ms: 1000 });
    const push = (sandbox: FakeSandbox, lines: string[]) => {
      for (const line of lines)
        sandbox.pushTail("/loop/everyapp-events.ndjson", line);
    };
    const world = makeWorld(repo, {
      eventLog: [],
      harnessLines: [],
      exec: (call, sandbox) => {
        const argv = call.argv.join(" ");
        if (argv === "fake --turn 1") {
          push(sandbox, [
            inv(
              11,
              t(0),
              ["setup", "--domain", `apps.${ZONE}`, "--json"],
              "/work/every-app",
            ),
            cliEvent({
              pid: 11,
              ts: t(6),
              type: "action_required",
              action: "claim_owner",
              message: "Open this link",
              data: { url: `${ORIGIN}/setup#token=${EST}`, waiting: true },
            }),
            cliEvent({
              pid: 11,
              ts: t(7),
              type: "step",
              step: "setup.owner",
              status: "ok",
            }),
            cliEvent({
              pid: 11,
              ts: t(8),
              type: "done",
              data: { gatewayUrl: ORIGIN },
            }),
            exit(11, t(8)),
          ]);
          return {
            stdout: [
              "TEXT Open the setup link I printed and tell me when you have.",
              "RESULT",
            ],
            code: 0,
          };
        }
        if (argv.startsWith("fake --resume s1")) {
          push(sandbox, [
            inv(12, t(9), ["create", "hello", "--json"], "/work/every-app"),
            cliEvent({
              pid: 12,
              ts: t(10),
              type: "done",
              data: { appId: "hello" },
            }),
            exit(12, t(10)),
            inv(13, t(11), ["deploy", "--json"], "/work/every-app/apps/hello"),
            cliEvent({
              pid: 13,
              ts: t(13),
              type: "done",
              data: { url: `https://${APP_HOST}` },
            }),
            exit(13, t(13)),
          ]);
          return { stdout: [`TEXT DONE ${ORIGIN}`, "RESULT"], code: 0 };
        }
        return undefined;
      },
    });
    const outcome = await runLoop(
      options({ harness: "claude", claimAfter: "turn-end" }),
      { ...world.deps, createHarness: () => fakeTurnsAdapter() },
    );
    const text = world.logs.join("\n");
    const record = outcome.record!;
    const turn1 = world.timeline.findIndex((e) => e === "exec fake --turn 1");
    const claim = world.timeline.findIndex(
      (e) => e === `gateway POST ${ORIGIN}/api/setup/claim`,
    );
    const turn2 = world.timeline.findIndex((e) =>
      e.startsWith("exec fake --resume s1"),
    );
    expect(turn1, text).toBeGreaterThanOrEqual(0);
    expect(claim, world.timeline.join("\n")).toBeGreaterThan(turn1);
    expect(turn2).toBeGreaterThan(claim);
    expect(record.steps.claim.how).toBe("event-log");
    expect(record.deviations).not.toContain("claim_immediate");
    expect(record.interventions).toEqual([]);
    expect(record.scriptedUserTurns.map((turn) => turn.trigger)).toEqual([
      "create_app",
    ]);
    expect(record.verdict.value, text).toBe("pass");
  });

  it("--claim-after turn-end: a link that appears in a later turn waits for that turn's end, not the first turn's (run 12 claimed it at once)", async () => {
    const repo = await makeRepo();
    const t = (s: number) =>
      `2026-10-25T14:${String(10 + s).padStart(2, "0")}:00.000Z`;
    const inv = (pid: number, ts: string, argv: string[], cwd: string) =>
      JSON.stringify({
        type: "invocation",
        pid,
        ts,
        argv: ["node", "cli.js", ...argv],
        cwd,
        json: true,
        isatty: { stdin: false, stdout: false, stderr: false },
        ci: false,
      });
    const exit = (pid: number, ts: string) =>
      JSON.stringify({ type: "exit", pid, ts, code: 0, ms: 1000 });
    const push = (sandbox: FakeSandbox, lines: string[]) => {
      for (const line of lines)
        sandbox.pushTail("/loop/everyapp-events.ndjson", line);
    };
    let resumes = 0;
    // When turn 2 ended, in real time: the claim must come after it. The fake exec keeps the
    // turn running for 40 ms after the link appears; with the gate open the claim lands within
    // a millisecond of the link, before this marker.
    let turn2EndedAt = 0;
    const world = makeWorld(repo, {
      eventLog: [],
      harnessLines: [],
      exec: (call, sandbox) => {
        const argv = call.argv.join(" ");
        // Turn 1: the domain question, nothing in the event log yet.
        if (argv === "fake --turn 1")
          return {
            stdout: ["TEXT Which domain should I use?", "RESULT"],
            code: 0,
          };
        if (argv.startsWith("fake --resume s1")) {
          resumes += 1;
          if (resumes === 1) {
            // Turn 2: setup runs, the link appears mid-turn, the turn ends asking the person.
            push(sandbox, [
              inv(
                11,
                t(1),
                ["setup", "--domain", `apps.${ZONE}`, "--json"],
                "/work/every-app",
              ),
              cliEvent({
                pid: 11,
                ts: t(6),
                type: "action_required",
                action: "claim_owner",
                message: "Open this link",
                data: { url: `${ORIGIN}/setup#token=${EST}`, waiting: true },
              }),
              cliEvent({
                pid: 11,
                ts: t(7),
                type: "step",
                step: "setup.owner",
                status: "ok",
              }),
              cliEvent({
                pid: 11,
                ts: t(8),
                type: "done",
                data: { gatewayUrl: ORIGIN },
              }),
              exit(11, t(8)),
            ]);
            setTimeout(() => {
              turn2EndedAt = Date.now();
            }, 25);
            return {
              stdout: [
                "TEXT Open the setup link I printed and tell me when you have.",
                "RESULT",
              ],
              code: 0,
              delayMs: 40,
            };
          }
          // Turn 3: create and deploy.
          push(sandbox, [
            inv(12, t(9), ["create", "hello", "--json"], "/work/every-app"),
            cliEvent({
              pid: 12,
              ts: t(10),
              type: "done",
              data: { appId: "hello" },
            }),
            exit(12, t(10)),
            inv(13, t(11), ["deploy", "--json"], "/work/every-app/apps/hello"),
            cliEvent({
              pid: 13,
              ts: t(13),
              type: "done",
              data: { url: `https://${APP_HOST}` },
            }),
            exit(13, t(13)),
          ]);
          return { stdout: [`TEXT DONE ${ORIGIN}`, "RESULT"], code: 0 };
        }
        return undefined;
      },
    });
    const outcome = await runLoop(
      options({ harness: "claude", claimAfter: "turn-end" }),
      { ...world.deps, createHarness: () => fakeTurnsAdapter() },
    );
    const text = world.logs.join("\n");
    const timeline = world.timeline;
    const execs = timeline
      .map((e, i) => (e.startsWith("exec fake --") ? i : -1))
      .filter((i) => i >= 0);
    const claim = timeline.findIndex(
      (e) => e === `gateway POST ${ORIGIN}/api/setup/claim`,
    );
    expect(execs.length, timeline.join("\n")).toBe(3);
    // Claimed after turn 2 started (the link's turn) and before turn 3, never between turns 1 and 2.
    expect(claim, timeline.join("\n")).toBeGreaterThan(execs[1]!);
    expect(claim).toBeLessThan(execs[2]!);
    expect(turn2EndedAt).toBeGreaterThan(0);
    expect(
      Date.parse(outcome.record!.steps.claim.claimedAt!),
    ).toBeGreaterThanOrEqual(turn2EndedAt);
    expect(outcome.record!.steps.claim.how).toBe("event-log");
    expect(outcome.record!.verdict.value, text).toBe("pass");
    expect(
      outcome.record!.scriptedUserTurns.map((turn) => turn.trigger),
    ).toEqual(["domain_question", "create_app"]);
  });

  it("register_workers_subdomain in the event log is answered by the REST PUT and a queued reply; the control cannot be resumed", async () => {
    const repo = await makeRepo();
    const t = "2026-10-25T14:10:00.000Z";
    const world = makeWorld(repo, {
      eventLog: [
        JSON.stringify({
          type: "invocation",
          pid: 31,
          ts: t,
          argv: [
            "node",
            "cli.js",
            "setup",
            "--domain",
            `apps.${ZONE}`,
            "--json",
          ],
          cwd: "/work/every-app",
          json: true,
          isatty: { stdin: false, stdout: false, stderr: false },
          ci: false,
        }),
        cliEvent({
          pid: 31,
          type: "action_required",
          action: "register_workers_subdomain",
          message: "Pick a workers.dev name",
          data: { url: "https://dash.cloudflare.com/" },
        }),
        JSON.stringify({ type: "exit", pid: 31, ts: t, code: 2, ms: 9000 }),
      ],
      harnessLines: [
        "LOOP_CMD pnpm install",
        "LOOP_EXIT 0",
        `LOOP_CMD pnpm everyapp setup --domain apps.${ZONE} --json`,
        "LOOP_EXIT 2",
        "LOOP_CMD pnpm everyapp setup --domain apps.${ZONE} --json",
        "LOOP_EXIT 2",
        "Setup keeps stopping",
      ],
      harnessExit: 0,
      gateway: {
        [`GET ${ORIGIN}/sign-in`]: () => new Response("", { status: 530 }),
      },
    });
    const outcome = await runLoop(options(), {
      ...world.deps,
      now: advancingClock(),
    });
    const record = outcome.record!;
    const put = world.cfCalls.find(
      (c) => c.method === "PUT" && c.path.endsWith("/workers/subdomain"),
    );
    expect(put?.body).toEqual({ subdomain: "everyapp-loop1" });
    expect(record.fixtures.workers_subdomain).toBe("first-run");
    expect(record.handoffs.exercised).toEqual(["register_workers_subdomain"]);
    expect(record.scriptedUserTurns.map((t) => t.trigger)).toEqual([
      "register_workers_subdomain",
    ]);
    expect(record.terminal_reason).toBe("harness_exit");
    expect(record.verdict.value).toBe("fail-onboarding");
    expect(world.logs.join("\n")).toContain(
      "registering the workers.dev subdomain everyapp-loop1",
    );
  });

  it("the event log the record reads is the copy docker cp took, not the tail's buffer: the CLI's last two lines (error, exit) reach everyappCommands[] and reparse", async () => {
    const repo = await makeRepo();
    const full = buildFailedEventLog();
    const world = makeWorld(repo, {
      // The tail stops two lines short: the `error` and `exit` lines were written in the second
      // before the process ended and the harness's exec returned (run 2026-10-24T07:36 saw 9 of 11).
      eventLog: full.slice(0, -2),
      harnessLines: buildFailedScriptLines,
      harnessExit: 1,
      gateway: unreachableGateway(),
      exec: gatewayNotFoundStatus,
    });
    const copyOut = world.sandbox.copyOut.bind(world.sandbox);
    world.sandbox.copyOut = async (handle, inside, host) => {
      await copyOut(handle, inside, host);
      if (inside !== "/loop") return;
      fs.mkdirSync(host, { recursive: true });
      fs.writeFileSync(
        path.join(host, "everyapp-events.ndjson"),
        `${full.join("\n")}\n`,
      );
    };
    const outcome = await runLoop(options(), {
      ...world.deps,
      now: advancingClock(),
    });
    const text = world.logs.join("\n");
    const record = outcome.record!;
    expect(text).toContain(
      "event log: the tail delivered 3 of 5 line(s); the copy from the container replaces it",
    );
    expect(record.everyappCommands).toHaveLength(1);
    expect(record.everyappCommands[0]).toMatchObject({
      argv: ["setup", "--domain", `apps.${ZONE}`, "--json"],
      exit: 1,
      ms: 18118,
      endedBy: "exit",
      events: { errors: ["GATEWAY_BUILD_FAILED"] },
    });
    expect(record.steps.setup).toEqual({ status: "error", reruns: 0 });
    expect(record.errors).toContainEqual({
      code: "GATEWAY_BUILD_FAILED",
      step: "setup",
      source: "cli",
      message: expect.stringContaining("exit 1"),
    });
    expect(record.verdict).toMatchObject({
      value: "fail-onboarding",
      reasonCode: "everyapp_error:GATEWAY_BUILD_FAILED",
    });
    // The run directory's everyapp-events.ndjson is the complete file, mode 600, and reparse reads it.
    const dir = path.join(world.runsRoot, outcome.runId);
    const onDisk = fs
      .readFileSync(path.join(dir, RUN_FILES.eventLog), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(onDisk).toHaveLength(5);
    expect(onDisk[4]).toContain('"type":"exit"');
    expect(fs.statSync(path.join(dir, RUN_FILES.eventLog)).mode & 0o077).toBe(
      0,
    );
    const logs: string[] = [];
    expect(
      recomputeMain({
        runsRoot: world.runsRoot,
        runId: outcome.runId,
        renormalize: false,
        log: (line) => logs.push(line),
      }),
    ).toBe(0);
    const reparsed = readRunRecord(world.runsRoot, outcome.runId);
    expect(reparsed.everyappCommands[0]).toMatchObject({
      exit: 1,
      events: { errors: ["GATEWAY_BUILD_FAILED"] },
    });
    expect(reparsed.verdict.reasonCode).toBe(
      "everyapp_error:GATEWAY_BUILD_FAILED",
    );
  });

  it("setup's GATEWAY_BUILD_FAILED decides fail-onboarding with the code, and the verifier probes a Gateway that was never uploaded once instead of waiting its windows", async () => {
    const repo = await makeRepo();
    const sleeps: number[] = [];
    const world = makeWorld(repo, {
      eventLog: buildFailedEventLog(),
      harnessLines: buildFailedScriptLines,
      harnessExit: 1,
      gateway: unreachableGateway(),
      exec: gatewayNotFoundStatus,
    });
    const outcome = await runLoop(options(), {
      ...world.deps,
      now: advancingClock(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const text = world.logs.join("\n");
    const record = outcome.record!;
    expect(outcome.exitCode).toBe(1);
    expect(record.verdict, text).toMatchObject({
      value: "fail-onboarding",
      reasonCode: "everyapp_error:GATEWAY_BUILD_FAILED",
      falseDone: false,
    });
    expect(record.terminal_reason).toBe("blocked");
    expect(record.everyappCommands[0]).toMatchObject({
      argv: ["setup", "--domain", `apps.${ZONE}`, "--json"],
      exit: 1,
      events: { errors: ["GATEWAY_BUILD_FAILED"] },
    });
    expect(record.verify.phaseReached).toBe("none");
    expect(record.verify.rows.G1).toBe("fail");
    // Every verifier row ran once: one probe of the sign-in page, one status, no 10-second poll.
    const verifyJson = JSON.parse(
      fs.readFileSync(
        path.join(world.runsRoot, outcome.runId, RUN_FILES.verify),
        "utf8",
      ),
    ) as { rows: Record<string, { attempts: number }> };
    for (const [id, row] of Object.entries(verifyJson.rows))
      expect(row.attempts, id).toBeLessThanOrEqual(1);
    expect(
      world.gatewayCalls.filter((c) => c === `GET ${ORIGIN}/sign-in`),
    ).toHaveLength(1);
    expect(
      world.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp status"),
      ),
    ).toHaveLength(1);
    expect(sleeps.filter((ms) => ms >= 10_000)).toEqual([]);
    // Both wipes ran, so the account holds nothing of the half-built install.
    expect(
      world.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp teardown"),
      ),
    ).toHaveLength(2);
    expect(record.errors.map((e) => e.code)).not.toContain(
      "teardown_after_failed",
    );
    expect(text).toContain(
      "fail-onboarding (everyapp_error:GATEWAY_BUILD_FAILED)",
    );
  });

  it("the driver's temp dir with the tools bundle outlives the post-run wipe and goes last; a bundle found missing is made again, so a run that failed early still ends with an empty account", async () => {
    const repo = await makeRepo();
    const bundleCopies: Array<{ hostPath: string; existed: boolean }> = [];
    let tempDirSeen: string | null = null;
    const world = makeWorld(repo, {
      eventLog: buildFailedEventLog(),
      harnessLines: buildFailedScriptLines,
      harnessExit: 1,
      gateway: unreachableGateway(),
      exec: gatewayNotFoundStatus,
    });
    // What the sibling sees when the bundle is copied in: is the file there at that moment?
    const copyIn = world.sandbox.copyIn.bind(world.sandbox);
    world.sandbox.copyIn = async (handle, hostPath, sandboxPath) => {
      if (hostPath.endsWith("/tools.bundle")) {
        bundleCopies.push({ hostPath, existed: fs.existsSync(hostPath) });
        tempDirSeen = path.dirname(hostPath);
      }
      await copyIn(handle, hostPath, sandboxPath);
    };
    const outcome = await runLoop(options(), {
      ...world.deps,
      now: advancingClock(),
    });
    const text = world.logs.join("\n");
    // The pre-run wipe and the post-run wipe each copied the bundle in, and it was there both times.
    expect(
      bundleCopies.map((c) => c.existed),
      text,
    ).toEqual([true, true]);
    expect(
      world.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp teardown"),
      ),
    ).toHaveLength(2);
    expect(outcome.record!.errors.map((e) => e.code)).not.toContain(
      "teardown_after_failed",
    );
    expect(outcome.record!.phases.map((p) => p.name)).toContain(
      "teardown.after",
    );
    expect(text).not.toContain("is gone before the wipe");
    // Logged at the two moments that matter, so a live run pins when a deletion happened.
    expect(text).toContain("temp dir present at verify start");
    expect(text).toContain("temp dir present before the post-run wipe");
    // Removed at the very end: nothing after cleanup needs it.
    expect(tempDirSeen).toMatch(/everyapp-loop-run-/);
    expect(fs.existsSync(tempDirSeen!)).toBe(false);

    // The live run of 2026-10-24 found the temp dir gone when the post-run wipe needed the bundle:
    // whatever removed it, the bundle is made again and the wipe runs.
    const again: Array<{ existed: boolean }> = [];
    const vanished = makeWorld(repo, {
      eventLog: buildFailedEventLog(),
      harnessLines: buildFailedScriptLines,
      harnessExit: 1,
      gateway: unreachableGateway(),
      exec: (call, sandbox) => {
        if (call.argv.join(" ") === "bash /loop/script.sh") {
          const bundle = sandbox.copiedIn.find((c) =>
            c.hostPath.endsWith("/tools.bundle"),
          )!;
          fs.rmSync(path.dirname(bundle.hostPath), {
            recursive: true,
            force: true,
          });
        }
        return gatewayNotFoundStatus(call);
      },
    });
    const copyInAgain = vanished.sandbox.copyIn.bind(vanished.sandbox);
    vanished.sandbox.copyIn = async (handle, hostPath, sandboxPath) => {
      if (hostPath.endsWith("/tools.bundle"))
        again.push({ existed: fs.existsSync(hostPath) });
      await copyInAgain(handle, hostPath, sandboxPath);
    };
    const second = await runLoop(options(), {
      ...vanished.deps,
      now: advancingClock(),
    });
    const secondText = vanished.logs.join("\n");
    expect(secondText).toContain("temp dir GONE at verify start");
    expect(secondText).toContain(
      "is gone before the verifier: making it again",
    );
    expect(secondText).toContain("is gone before the wipe: making it again");
    expect(
      again.map((c) => c.existed),
      secondText,
    ).toEqual([true, true]);
    expect(
      vanished.sandbox.execs.filter((e) =>
        e.argv.join(" ").includes("everyapp teardown"),
      ),
    ).toHaveLength(2);
    expect(second.record!.errors.map((e) => e.code)).not.toContain(
      "teardown_after_failed",
    );
    expect(
      fs.existsSync(
        path.dirname(
          vanished.sandbox.copiedIn.find((c) =>
            c.hostPath.endsWith("/tools.bundle"),
          )!.hostPath,
        ),
      ),
    ).toBe(false);
  });

  it("a reply still reaches the container after the temp dir vanished mid-harness: the dir is made again for it", async () => {
    const repo = await makeRepo();
    const t = (s: number) =>
      `2026-10-25T14:${String(10 + s).padStart(2, "0")}:00.000Z`;
    const inv = (pid: number, ts: string, argv: string[], cwd: string) =>
      JSON.stringify({
        type: "invocation",
        pid,
        ts,
        argv: ["node", "cli.js", ...argv],
        cwd,
        json: true,
        isatty: { stdin: false, stdout: false, stderr: false },
        ci: false,
      });
    const exit = (pid: number, ts: string) =>
      JSON.stringify({ type: "exit", pid, ts, code: 0, ms: 1000 });
    const push = (sandbox: FakeSandbox, lines: string[]) => {
      for (const line of lines)
        sandbox.pushTail("/loop/everyapp-events.ndjson", line);
    };
    let tempDir: string | null = null;
    const world = makeWorld(repo, {
      eventLog: [],
      harnessLines: [],
      exec: (call, sandbox) => {
        const argv = call.argv.join(" ");
        if (argv === "fake --turn 1") {
          push(sandbox, [
            inv(
              11,
              t(0),
              ["setup", "--domain", `apps.${ZONE}`, "--json"],
              "/work/every-app",
            ),
            cliEvent({
              pid: 11,
              ts: t(6),
              type: "action_required",
              action: "claim_owner",
              message: "Open this link",
              data: { url: `${ORIGIN}/setup#token=${EST}`, waiting: true },
            }),
            cliEvent({
              pid: 11,
              ts: t(7),
              type: "step",
              step: "setup.owner",
              status: "ok",
            }),
            cliEvent({
              pid: 11,
              ts: t(8),
              type: "done",
              data: { gatewayUrl: ORIGIN },
            }),
            exit(11, t(8)),
          ]);
          // Whatever removed the live run's temp dir does so while the harness runs.
          tempDir = path.dirname(
            sandbox.copiedIn.find((c) => c.sandboxPath === "/loop/prompt.txt")!
              .hostPath,
          );
          fs.rmSync(tempDir, { recursive: true, force: true });
          return {
            stdout: [
              "TEXT Open the setup link and tell me when you have.",
              "RESULT",
            ],
            code: 0,
          };
        }
        if (argv.startsWith("fake --resume s1")) {
          push(sandbox, [
            inv(12, t(9), ["create", "hello", "--json"], "/work/every-app"),
            cliEvent({
              pid: 12,
              ts: t(10),
              type: "done",
              data: { appId: "hello" },
            }),
            exit(12, t(10)),
            inv(13, t(11), ["deploy", "--json"], "/work/every-app/apps/hello"),
            cliEvent({
              pid: 13,
              ts: t(13),
              type: "done",
              data: { url: `https://${APP_HOST}` },
            }),
            exit(13, t(13)),
          ]);
          return { stdout: [`TEXT DONE ${ORIGIN}`, "RESULT"], code: 0 };
        }
        return undefined;
      },
    });
    const replies: Array<{ hostPath: string; existed: boolean }> = [];
    const copyIn = world.sandbox.copyIn.bind(world.sandbox);
    world.sandbox.copyIn = async (handle, hostPath, sandboxPath) => {
      if (/\/reply-\d+\.txt$/.test(hostPath))
        replies.push({ hostPath, existed: fs.existsSync(hostPath) });
      await copyIn(handle, hostPath, sandboxPath);
    };
    const outcome = await runLoop(
      options({ harness: "claude", claimAfter: "turn-end" }),
      { ...world.deps, createHarness: () => fakeTurnsAdapter() },
    );
    const text = world.logs.join("\n");
    expect(tempDir).not.toBeNull();
    expect(replies, text).toHaveLength(1);
    expect(replies[0]!.existed).toBe(true);
    expect(path.dirname(replies[0]!.hostPath)).toBe(tempDir);
    expect(text).toContain("reply 1:");
    expect(outcome.record!.verdict.value, text).toBe("pass");
    expect(outcome.record!.errors.map((e) => e.code)).not.toContain(
      "teardown_after_failed",
    );
    expect(fs.existsSync(tempDir!)).toBe(false);
  });

  it("with the seam but no setup in the log (the npx trap), the verifier keeps its windows: nothing says the Gateway is absent", async () => {
    const repo = await makeRepo();
    const world = makeWorld(repo, {
      eventLog: [],
      harnessLines: [
        "LOOP_CMD pnpm install",
        "LOOP_EXIT 0",
        "LOOP_CMD npx everyapp setup --json",
        "LOOP_EXIT 1",
        "BLOCKED: setup exited 1",
      ],
      harnessExit: 1,
      gateway: unreachableGateway(),
      exec: gatewayNotFoundStatus,
    });
    const outcome = await runLoop(options(), {
      ...world.deps,
      now: advancingClock(),
    });
    const record = outcome.record!;
    expect(record.everyappCommands).toEqual([]);
    const verifyJson = JSON.parse(
      fs.readFileSync(
        path.join(world.runsRoot, outcome.runId, RUN_FILES.verify),
        "utf8",
      ),
    ) as { rows: Record<string, { attempts: number }> };
    expect(verifyJson.rows["G1"]!.attempts).toBeGreaterThan(1);
    expect(record.verdict).toMatchObject({
      value: "fail-infra",
      reasonCode: "gateway_unreachable",
    });
  });

  it("a failed preflight (the account is locked by another run, --no-wait) writes a fail-infra record and creates nothing", async () => {
    const repo = await makeRepo();
    const world = makeWorld(repo, { eventLog: [], harnessLines: [] });
    const held = acquireAccountLock(
      path.join(world.configDir, "locks"),
      ID,
      "other-run",
    );
    try {
      // Without --no-wait the run would wait for other-run (this process) to release the lock.
      const outcome = await runLoop({ ...options(), wait: false }, world.deps);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.record?.terminal_reason).toBe("preflight_failed");
      expect(outcome.record?.verdict).toMatchObject({
        value: "fail-infra",
        reasonCode: "preflight_failed",
      });
      expect(outcome.record?.errors[0]?.message).toMatch(
        /locked by run other-run/,
      );
      expect(world.sandbox.created).toEqual([]);
      expect(world.cfCalls).toEqual([]);
    } finally {
      held.release();
    }
  });

  it("the commands over a finished run: reparse and replay keep the verdict, report writes whitelisted files, findings renders the hand-off, answer refuses, gc removes", async () => {
    const repo = await makeRepo();
    const world = makeWorld(repo, {
      eventLog: happyEventLog(),
      harnessLines: happyScriptLines,
    });
    const outcome = await runLoop(options(), world.deps);
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    const common = { runsRoot: world.runsRoot, runId: outcome.runId, log };
    expect(recomputeMain({ ...common, renormalize: true })).toBe(0);
    expect(recomputeMain({ ...common, renormalize: false })).toBe(0);
    expect(logs.filter((l) => l.includes("verdict pass -> pass"))).toHaveLength(
      2,
    );
    expect(
      readRunRecord(world.runsRoot, outcome.runId).everyappCommands,
    ).toHaveLength(3);

    const docsRepo = tempDir("loop-report-repo-");
    expect(
      reportMain({ runsRoot: world.runsRoot, repoRoot: docsRepo, log }),
    ).toBe(0);
    const reportDir = path.join(docsRepo, "docs/onboarding-loop");
    const written = fs.readdirSync(reportDir).sort();
    expect(written).toEqual([
      "README.md",
      "findings.json",
      "findings.md",
      "runs",
    ]);
    const everything = Object.values(runFiles(reportDir)).join("\n");
    expect(everything).not.toContain(ZONE);
    expect(everything).not.toContain(ID);
    expect(everything).not.toContain("@");
    expect(everything).not.toContain("est_");
    expect(
      fs.readFileSync(path.join(reportDir, "README.md"), "utf8"),
    ).toContain("| script bash |");

    expect(
      findingsMain({
        runsRoot: world.runsRoot,
        repoRoot: docsRepo,
        configDir: world.configDir,
        runId: null,
        threadIds: {},
        log,
      }),
    ).toBe(0);
    expect(logs.join("\n")).toContain(`# Hand-off for run ${outcome.runId}`);
    expect(
      fs.existsSync(
        path.join(world.configDir, "handoff", `${outcome.runId}.md`),
      ),
    ).toBe(true);

    expect(answerMain({ ...common, text: "hello" })).toBe(1);
    expect(logs.at(-1)).toMatch(/has finished/);

    expect(
      await gcMain({
        runsRoot: world.runsRoot,
        configDir: world.configDir,
        docker: null,
        days: 0,
        now: Date.now() + 1000,
        log,
      }),
    ).toBe(0);
    expect(fs.existsSync(path.join(world.runsRoot, outcome.runId))).toBe(false);
  });

  it("refuses mode raised (not built) and a harness whose provider key is missing", async () => {
    const repo = await makeRepo();
    const world = makeWorld(repo, { eventLog: [], harnessLines: [] });
    await expect(
      runLoop(options({ harness: "claude", mode: "raised" }), world.deps),
    ).rejects.toThrow(/raised/);
    await expect(
      runLoop(options({ harness: "codex" }), world.deps),
    ).rejects.toThrow(/CODEX_API_KEY/);
    expect(world.sandbox.created).toEqual([]);
  });
});
