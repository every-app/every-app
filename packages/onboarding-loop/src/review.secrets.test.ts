/**
 * Adversarial review, secrets and blast radius (2026-10-24): each test here
 * names a hole found by reading the code and FAILS against the build as
 * reviewed. They are the acceptance tests for the fixes; delete the
 * "review" framing once they pass and fold them into the module's own test
 * file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locksDir } from "./accounts";
import { createCfApi, createFakeCfFetch } from "./cf";
import type { Docker, DockerInfo } from "./docker";
import { acquireAccountLock } from "./lock";
import { collectMain, gcMain, reportMain } from "./maintenance";
import { runPreflight } from "./preflight";
import { emptyRunRecord, RUN_FILES, writeRunRecord } from "./record";
import {
  containerName,
  DEFAULT_RUN_OPTIONS,
  runLoop,
  type RunDeps,
} from "./run";
import { FakeSandbox, type FakeExecCall } from "./sandbox";
import { createFakeSpawn, spawnProcess, capture, type Spawn } from "./spawn";
import type { Account, FetchLike } from "./types";
import { verify, type VerifyDeps } from "./verify";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const ZONE = "everyapp-loop1.com";
const TOKEN = "fake-token-abcdefghijklmnopqrstuv";
const PROVIDER_KEY = "sk-ant-fake-provider-key-0123456789";
/** A provider key with no shape the redactor knows (OpenCode Zen, Cursor): only the exact value catches it. */
const SHAPELESS_KEY = "zen-opaque-value-with-no-known-prefix-0123456789";
const ORIGIN = `https://apps.${ZONE}`;
const APP_HOST = `hello.apps.${ZONE}`;
const EST = `est_${"b".repeat(43)}`;
const COOKIE = "better-auth.session_token=abc; Path=/; HttpOnly";
const SESSION_TOKEN = "SESSION_TOKEN_MUST_NOT_BE_KEPT_0123456789";
const GIB = 1024 ** 3;
const NOW = Date.parse("2026-10-25T12:00:00Z");

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

const account: Account = {
  name: "loop-1",
  accountId: ID,
  zone: ZONE,
  email: `owner@${ZONE}`,
  token: TOKEN,
};

const lsof = createFakeSpawn(() => ({
  stdout: [
    "COMMAND PID",
    "node 1 ben 20u IPv4 0 0t0 TCP 127.0.0.1:3000 (LISTEN)",
  ],
})).spawn;

function fakeDocker(containers: string[]) {
  const removed: string[][] = [];
  const info: DockerInfo = {
    engine: "29.8.2",
    memBytes: 16 * GIB,
    ncpu: 18,
    os: "linux",
    arch: "aarch64",
  };
  const docker = {
    info: async () => info,
    listContainers: async (prefix: string) =>
      containers.filter((name) => name.startsWith(prefix)),
    removeContainers: async (names: string[]) => {
      removed.push(names);
    },
    imageExists: async () => true,
    clockSkewSeconds: async () => 0.1,
  };
  return { docker, removed };
}

// ---------------------------------------------------------------------------
// 1. The forbidden account id is not refused by preflight itself.
// ---------------------------------------------------------------------------
describe("preflight refuses the forbidden account by constant (design 1: 'whatever any list says')", () => {
  it("fails preflight for Ben's account id even with no Cloudflare client (dry run)", async () => {
    const configDir = tempDir("review-preflight-");
    const result = await runPreflight({
      account: { ...account, accountId: "badc0ffee0ddf00dbadc0ffee0ddf00d" },
      runId: "2026-10-25T12:00-script-abc123",
      dryRun: true,
      image: "everyapp-loop:abc",
      configDir,
      docker: null,
      cf: null,
      env: {
        PATH: "/bin",
        EVERYAPP_FORBIDDEN_ACCOUNTS: "badc0ffee0ddf00dbadc0ffee0ddf00d",
      },
      spawn: lsof,
      now: () => NOW,
    });
    // preflight.ts step 2 says "the forbidden one ... said again here, cheaply" but only tests /^[0-9a-f]{32}$/.
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "account")?.status).toBe(
      "fail",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Preflight and gc `docker rm -f` a live lane's containers.
// ---------------------------------------------------------------------------
describe("another lane's running containers survive a second driver's preflight and gc", () => {
  const liveRunId = "2026-10-25T11:30-claude-opus55-aaaaaa";
  const liveContainers = [
    containerName(liveRunId),
    "loop-sib-claude-opus55-aaaaaa-ab12",
  ];

  it("preflight (even --dry-run on the other account) does not remove containers of a run whose lock is live", async () => {
    const configDir = tempDir("review-stale-");
    // Lane A holds its lock on the other account and is mid-run.
    acquireAccountLock(locksDir(configDir), OTHER_ID, liveRunId, { now: NOW });
    const { docker, removed } = fakeDocker(liveContainers);
    const result = await runPreflight({
      account,
      runId: "2026-10-25T12:00-script-bbbbbb",
      dryRun: true,
      image: "everyapp-loop:abc",
      configDir,
      docker,
      cf: null,
      env: { PATH: "/bin" },
      spawn: lsof,
      now: () => NOW,
    });
    expect(result.ok).toBe(true);
    expect(removed.flat()).not.toContain(containerName(liveRunId));
    expect(removed.flat()).not.toContain("loop-sib-claude-opus55-aaaaaa-ab12");
  });

  it("gc removes only containers no live lock owns (README: 'exited loop-* containers')", async () => {
    const configDir = tempDir("review-gc-");
    acquireAccountLock(locksDir(configDir), OTHER_ID, liveRunId, { now: NOW });
    const { docker, removed } = fakeDocker(liveContainers);
    const logs: string[] = [];
    await gcMain({
      runsRoot: path.join(configDir, "runs"),
      configDir,
      docker: docker as unknown as Docker,
      days: 30,
      now: NOW,
      log: (l) => logs.push(l),
    });
    expect(removed.flat()).not.toContain(containerName(liveRunId));
  });
});

// ---------------------------------------------------------------------------
// 3. verify.json keeps the owner's session token from the sign-in body.
// ---------------------------------------------------------------------------
describe("the verifier's evidence never holds a credential", () => {
  it("O1's sign-in evidence does not carry Better Auth's session token from the response body", async () => {
    const owner = {
      name: "Loop Owner",
      email: `owner@${ZONE}`,
      password: "pw-not-real-0123456789",
    };
    const routes: Record<string, (init: RequestInit) => Response> = {
      [`GET ${ORIGIN}/sign-in`]: () =>
        new Response("<html>sign in</html>", { status: 200 }),
      [`POST ${ORIGIN}/api/setup/claim`]: () =>
        new Response('{"error":"ORIGIN_NOT_ALLOWED"}', { status: 403 }),
      [`GET ${ORIGIN}/mcp`]: () =>
        new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="OAuth", resource_metadata="https://apps.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      [`GET https://nope-cafe0000.apps.${ZONE}/`]: () =>
        new Response('{"error":"unknown_app_host"}', { status: 404 }),
      // Better Auth's real shape: { redirect, token, user } with the session token in the body.
      [`POST ${ORIGIN}/api/auth/sign-in/email`]: () =>
        new Response(
          JSON.stringify({
            redirect: false,
            token: SESSION_TOKEN,
            user: { id: "u1", email: owner.email, name: owner.name },
          }),
          { status: 200, headers: { "set-cookie": COOKIE } },
        ),
      [`GET ${ORIGIN}/api/auth/get-session`]: () =>
        new Response(JSON.stringify({ user: { email: owner.email } }), {
          status: 200,
        }),
      [`GET https://${APP_HOST}/`]: (init) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        if (headers["cookie"])
          return new Response("<html>Todos</html>", { status: 200 });
        if (headers["accept"] === "text/html")
          return new Response("", {
            status: 302,
            headers: { location: `${ORIGIN}/sign-in?return_to=x` },
          });
        return new Response('{"error":"unauthenticated"}', { status: 401 });
      },
    };
    const fetchImpl: FetchLike = async (url, init = {}) => {
      const route = routes[`${init.method ?? "GET"} ${url}`];
      if (!route) throw new TypeError(`no route for ${url}`);
      return route(init);
    };
    const deps: VerifyDeps = {
      fetchImpl,
      runStatus: async () => ({
        exitCode: 0,
        events: [],
        data: {
          claimed: true,
          owner: { email: owner.email },
          upToDate: true,
          apps: [
            { id: "hello", status: "active", bound: true, hostname: APP_HOST },
          ],
          fixes: [],
        },
      }),
      sleep: async () => undefined,
      windowMs: 1,
      randomLabel: () => "cafe0000",
    };
    const result = await verify(
      {
        zone: ZONE,
        gatewayOrigin: ORIGIN,
        appHost: APP_HOST,
        owner,
        claimHow: "event-log",
        diff: [],
        events: [],
        harnessDeployedApp: true,
        withAccess: false,
        team: null,
        templateMarker: "Todos",
      },
      deps,
    );
    expect(result.rows.O1.status).toBe("pass");
    // verify.json is JSON.stringify(result): a bearer-equivalent for the owner must not be in it.
    expect(JSON.stringify(result)).not.toContain(SESSION_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// 4. `loop collect` redacts with the token only; a shapeless provider key stays.
// ---------------------------------------------------------------------------
describe("`loop collect` redacts every exact value the driver holds, not only the token", () => {
  it("rewrites a collected file that holds the provider key from providers.env", async () => {
    const configDir = tempDir("review-collect-");
    fs.writeFileSync(
      path.join(configDir, "accounts.json"),
      JSON.stringify({ accounts: [account] }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(configDir, "providers.env"),
      `OPENCODE_API_KEY=${SHAPELESS_KEY}\n`,
      { mode: 0o600 },
    );
    const runsRoot = path.join(configDir, "runs");
    const runId = "2026-10-25T12:00-opencode-glm53-cccccc";
    const record = emptyRunRecord({
      runId,
      startedAt: "2026-10-25T12:00:00.000Z",
      accountName: account.name,
      harness: {
        name: "opencode",
        version: "2.1.3",
        model: { requested: "opencode/glm-5.3", resolved: null },
        mode: null,
        commandLine: "opencode run",
        permissionBypass: true,
      },
      signal: {
        toolCalls: "full",
        toolOutput: "truncated",
        exitCodes: true,
        cost: "harness",
        resume: "native",
      },
      checkout: { commit: "a".repeat(40), ref: "HEAD", how: "bundle" },
      cli: { commit: "a".repeat(40), version: "0.3.0" },
      prompt: { variant: "checkout-present", sha256: "b".repeat(64) },
      substrate: {
        kind: "docker",
        engine: "29.8.2",
        image: { tag: "everyapp-loop:abc", platform: "linux/arm64" },
        vmMemoryGiB: 16,
        statsPeakMiB: null,
      },
    });
    writeRunRecord(runsRoot, record);
    const name = containerName(runId);
    const docker = {
      listContainers: async () => [name],
      sandbox: {
        copyOut: async (_h: unknown, inside: string, host: string) => {
          if (inside !== "/loop") throw new Error("not there");
          fs.mkdirSync(host, { recursive: true });
          // What an agent that ran `env` leaves in /loop (a tee of its own output).
          fs.writeFileSync(
            path.join(host, "env.txt"),
            `OPENCODE_API_KEY=${SHAPELESS_KEY}\nCLOUDFLARE_API_TOKEN=${TOKEN}\n`,
          );
        },
        diff: async () => [],
      },
    } as unknown as Docker;
    const logs: string[] = [];
    const code = await collectMain({
      runsRoot,
      configDir,
      runId,
      docker,
      log: (l) => logs.push(l),
    });
    expect(code).toBe(0);
    const text = fs.readFileSync(
      path.join(runsRoot, runId, "collected-again", "loop", "env.txt"),
      "utf8",
    );
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SHAPELESS_KEY);
  });
});

// ---------------------------------------------------------------------------
// 5. run.json and the committed report are built from the raw in-memory
//    events: a harness that echoes the token puts it in both.
// ---------------------------------------------------------------------------
async function makeRepo(): Promise<string> {
  const repo = tempDir("review-repo-");
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
    'const name = "EVERYAPP_EVENT_LOG";\n',
  );
  fs.writeFileSync(
    path.join(repo, "landing-page/content/agent/index.md"),
    "# agent docs\n",
  );
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "fixture"]);
  return repo;
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
const statusDone = cliEvent({
  type: "done",
  data: {
    claimed: true,
    owner: { email: `owner@${ZONE}` },
    apps: [{ id: "hello", status: "active", bound: true, hostname: APP_HOST }],
    upToDate: true,
    fixes: [],
  },
});

function happyEventLog(): string[] {
  const t = (s: number) =>
    `2026-10-25T14:${String(10 + s).padStart(2, "0")}:00.000Z`;
  const inv = (pid: number, ts: string, argv: string[], cwd: string) =>
    JSON.stringify({
      type: "invocation",
      pid,
      ts,
      argv,
      cwd,
      json: true,
      isatty: { stdin: false, stdout: false, stderr: false },
      ci: false,
    });
  const exit = (pid: number, ts: string, ms: number) =>
    JSON.stringify({ type: "exit", pid, ts, code: 0, ms });
  return [
    inv(
      11,
      t(0),
      ["node", "cli.js", "setup", "--domain", `apps.${ZONE}`, "--json"],
      "/work/every-app",
    ),
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
    exit(11, t(8), 480000),
    inv(
      12,
      t(9),
      ["node", "cli.js", "create", "hello", "--json"],
      "/work/every-app",
    ),
    cliEvent({ pid: 12, ts: t(10), type: "done", data: { appId: "hello" } }),
    exit(12, t(10), 60000),
    inv(
      13,
      t(11),
      ["node", "cli.js", "deploy", "--json"],
      "/work/every-app/apps/hello",
    ),
    cliEvent({
      pid: 13,
      ts: t(13),
      type: "done",
      data: { url: `https://${APP_HOST}` },
    }),
    exit(13, t(13), 120000),
  ];
}

function makeWorld(repo: string, harnessLines: string[]) {
  const configDir = tempDir("review-world-");
  fs.writeFileSync(
    path.join(configDir, "accounts.json"),
    JSON.stringify({ accounts: [account] }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(configDir, "providers.env"),
    `ANTHROPIC_API_KEY=${PROVIDER_KEY}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(configDir, `confirm-${ID}`),
    `delete everything in ${ID}\n`,
    { mode: 0o600 },
  );
  const runsRoot = path.join(configDir, "runs");
  const logs: string[] = [];
  const sandbox = new FakeSandbox((call: FakeExecCall) => {
    const argv = call.argv.join(" ");
    if (argv.includes("everyapp teardown")) return { stdout: [teardownDone] };
    if (argv.includes("everyapp status")) return { stdout: [statusDone] };
    if (argv === "bash --version")
      return { stdout: ["GNU bash, version 5.2.15"] };
    if (argv.startsWith("bash -c tr"))
      return { stdout: ["TERM=dumb", "SHELL=/bin/bash"] };
    if (argv === "bash /loop/script.sh") {
      for (const line of happyEventLog())
        sandbox.pushTail("/loop/everyapp-events.ndjson", line);
      return { stdout: harnessLines, code: 0 };
    }
    return { code: 0 };
  });
  const docker: Docker = {
    binary: "/fake/docker",
    info: async () => ({
      engine: "29.8.2",
      memBytes: 16 * GIB,
      ncpu: 18,
      os: "linux",
      arch: "aarch64",
    }),
    listContainers: async () => [],
    removeContainers: async () => undefined,
    imageExists: async () => true,
    imageSizeBytes: async () => 1,
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
      method: "GET",
      path: new RegExp(`^/accounts/${ID}/d1/database$`),
      reply: () => ({ result: [{ uuid: "db-gw", name: "every-app-gateway" }] }),
    },
    {
      method: "POST",
      path: new RegExp(`^/accounts/${ID}/d1/database/db-gw/query$`),
      reply: () => ({ result: [{ results: [], success: true }] }),
    },
    {
      method: "GET",
      path: new RegExp(`^/accounts/${ID}/storage/kv/namespaces$`),
      reply: () => ({ result: [] }),
    },
    {
      method: "POST",
      path: new RegExp(`^/accounts/${ID}/storage/kv/namespaces$`),
      reply: (_m, call) => ({
        result: {
          id: "kv-marker",
          title: (call.body as { title: string }).title,
        },
      }),
    },
    {
      method: "GET",
      path: /^\/zones\/z1\/dns_records$/,
      reply: () => ({ result: [] }),
    },
  ]);
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
        return new Response("<html><h1>Todos</h1></html>", { status: 200 });
      if (headers["accept"] === "text/html")
        return new Response("", {
          status: 302,
          headers: { location: `${ORIGIN}/sign-in?return_to=x` },
        });
      return new Response('{"error":"unauthenticated"}', { status: 401 });
    },
  };
  const gatewayFetch: FetchLike = async (url, init = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    if (/^GET https:\/\/nope-[0-9a-f]+\.apps\./.test(key))
      return new Response('{"error":"unknown_app_host"}', { status: 404 });
    const route = routes[key];
    if (!route) return new Response("no route", { status: 599 });
    return route(init);
  };
  const spawn: Spawn = (bin, args, opts) =>
    bin === "git" ? spawnProcess(bin, args, opts) : lsof(bin, args, opts);
  const deps: RunDeps = {
    configDir,
    runsRoot,
    repoRoot: repo,
    dockerfile: path.join(repo, "Dockerfile.fake"),
    docker,
    spawn,
    createCf: (a) =>
      createCfApi({ token: a.token, accountId: a.accountId, fetch: cf.fetch }),
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
  return { deps, logs, runsRoot, configDir };
}

describe("a harness that echoes a secret leaves it in no record and no committed file", () => {
  it("run.json, assemble-input.json and docs/onboarding-loop/runs/*.json carry no token after the harness printed it", async () => {
    const repo = await makeRepo();
    // The control script does everything right, then ends its turn on a line that echoes the token
    // (what `env` or a careless `echo $CLOUDFLARE_API_TOKEN` does) instead of DONE: the hesitation
    // `ended_turn_without_done` takes that line as its excerpt.
    const world = makeWorld(repo, [
      "LOOP_CMD pnpm install",
      "LOOP_EXIT 0",
      `LOOP_CMD pnpm everyapp setup --domain apps.${ZONE} --json`,
      "LOOP_EXIT 0",
      "LOOP_CMD pnpm everyapp create hello --json",
      "LOOP_EXIT 0",
      "LOOP_CMD pnpm everyapp deploy --json",
      "LOOP_EXIT 0",
      `I need you to rotate CLOUDFLARE_API_TOKEN=${TOKEN} and ANTHROPIC_API_KEY=${PROVIDER_KEY}`,
    ]);
    const outcome = await runLoop(
      { ...DEFAULT_RUN_OPTIONS, harness: "script", account: "loop-1" },
      world.deps,
    );
    const text = world.logs.join("\n");
    expect(outcome.record, text).not.toBeNull();
    const record = outcome.record!;
    // The redactor saw the line: the counters say so (this part passes today).
    expect(record.secret_exposure.cf_token).toBeGreaterThan(0);
    expect(
      record.hesitations.some((h) => h.kind === "ended_turn_without_done"),
    ).toBe(true);
    // Nothing the driver printed carries it (passes today: the driver's log is redacted).
    expect(text).not.toContain(TOKEN);

    const dir = path.join(world.runsRoot, outcome.runId);
    for (const name of [
      RUN_FILES.record,
      RUN_FILES.assembleInput,
      RUN_FILES.decideInput,
    ]) {
      const content = fs.readFileSync(path.join(dir, name), "utf8");
      expect(content, name).not.toContain(TOKEN);
      expect(content, name).not.toContain(PROVIDER_KEY);
    }

    // The committed report: whitelisted fields, but `hesitations[].excerpt` goes through `scrub`
    // (est_/32-hex/@ only), never through the redactor that knows the values.
    const repoRoot = tempDir("review-report-");
    reportMain({ runsRoot: world.runsRoot, repoRoot, log: () => undefined });
    const runsDir = path.join(repoRoot, "docs/onboarding-loop/runs");
    const committed = fs
      .readdirSync(runsDir)
      .map((f) => fs.readFileSync(path.join(runsDir, f), "utf8"))
      .join("\n");
    expect(committed).not.toContain(TOKEN);
    expect(committed).not.toContain(PROVIDER_KEY);
  });
});
