/**
 * The CLI as people run it: bin/everyapp.js over the dist/ tsup built, as
 * a child process, against a fresh app in a temp directory outside the
 * checkout, with no Cloudflare account. The unit tests resolve every
 * workspace package from source, so they never see what the bundle does
 * differently: on 2026-10-24 the built CLI refused every manifest with a
 * capability that takes no scope sets (the perimeter's manifest schema,
 * inlined into dist, ran against the CLI's zod 4 instead of the
 * perimeter's zod 3; #543) while `pnpm test` was green.
 *
 * In order, sharing one app: help for every route, the version, an unknown
 * command under --json; `create`; `db migrate`; `dev` up to the first 200
 * through the gateway-lite and down on SIGINT; a manifest with members,
 * email, dataforseo, context and a scoped Slack client through `db migrate`
 * (the #543 regression) and one with scopes on members refused; `release`
 * (a production build, not the development one a stray NODE_ENV makes);
 * `status --json` and `configure <app> --json` (NAME=value lines on stdin,
 * then --from-env, then the refusals) against a fake Cloudflare account
 * (lib/cf/bin.ts's EVERYAPP_CF_BINARY seam points cf at a stand-in that
 * answers from src/test/fakeCloudflare.ts over a loopback bridge). Every --json line must
 * be a protocol event and the exit codes must follow it; no run may rebuild
 * dist (the launcher says "Updated everyapp CLI" when it does).
 *
 * Skipped unless EVERYAPP_BUILT_CLI=1, after `pnpm -C packages/sdk build`
 * and `pnpm -C packages/cli build`:
 *
 *   pnpm test:built-cli               (checkout root: builds both, then runs this)
 *   pnpm -C packages/cli test:built   (dist/ already built)
 *
 * The new app's `pnpm install` needs the network once;
 * .github/workflows/integration.yml runs it nightly, on main and on demand.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandPaths } from "@/app";
import { DEFAULT_WORKER, WORKERS_DIR } from "@/lib/app/buildOutput";
import { openAppRelease } from "@/lib/app/release";
import { cfD1Database } from "@/lib/cf/d1";
import { CfError } from "@/lib/cf/errors";
import { applyGateway } from "@/lib/gateway/apply";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { markDeployed, register } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";

const CLI_DIR = fileURLToPath(new URL("../../", import.meta.url));
const LAUNCHER = path.join(CLI_DIR, "bin", "everyapp.js");
/** The app `create` makes, and so the first Host label `dev` routes by. */
const APP_ID = "notes";
/** The app registered on the fake Gateway, which `status` must list. */
const REGISTERED_APP = "crm";
/** The app registered with settings to set, which `configure` sets from stdin and the environment. */
const CONFIGURED_APP = "seo";
const EVENT_TYPES = new Set(["step", "progress", "warning", "error", "action_required", "done"]);
/** What the launcher prints after it rebuilt dist/: never, here. */
const REBUILT = /Updated everyapp CLI/;

/**
 * Members, email and the API-key capabilities take no scope sets (what #543
 * fixed); Slack has a scope policy, so its entry names sets. Inserted into
 * the created app's own manifest so its id and resources stay the starter's
 * and `dev` and `release` still work.
 */
const CAPABILITIES = `capabilities: {
    members: { access: "read", why: "Whom the weekly digest goes to." },
    email: { access: "write", why: "Sends the weekly digest." },
    dataforseo: { access: "read", why: "Keyword data for the digest." },
    context: { access: "read", optional: true, why: "Renders the pages the digest links." },
    slack: {
      access: "write",
      why: "Posts the digest to a channel.",
      scopes: ["channels.read", "messages.write"],
    },
  },`;

/** Refused: members takes no scope sets. */
const NEGATIVE_CAPABILITIES = `capabilities: {
    members: { access: "read", why: "Whom the weekly digest goes to.", scopes: ["anything"] },
  },`;

/** The app's host serves /mcp: an object with a reason. */
const MCP_OPT_IN = `mcp: { by: "gateway", why: "Scripts drive this app alone." },`;
/** Refused: the field's old string form. */
const MCP_OLD_FORM = `mcp: "gateway",`;

/**
 * Stands in for cf under EVERYAPP_CF_BINARY: hands the call (its arguments,
 * the files an `@path` argument names, and which mode and account the
 * runner's env says) to the test's bridge, writes what the fake account
 * answered, and exits as cf would.
 */
const CF_STAND_IN = `// Stands in for cf under the built-CLI test (src/bin/builtCli.test.ts).
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const files = {};
for (const arg of args) {
  if (!arg.startsWith("@")) continue;
  try {
    files[path.basename(arg.slice(1))] = fs.readFileSync(arg.slice(1), "utf8");
  } catch {
    // Not a file cf was handed.
  }
}
const response = await fetch(process.env.EVERYAPP_CF_BRIDGE, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    args,
    cwd: process.cwd(),
    json: process.env.CF_QUIET === "1",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
    files,
  }),
});
const { stdout, stderr, exitCode } = await response.json();
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = exitCode;
`;

interface Event {
  v: number;
  ts: string;
  type: string;
  code?: string;
  message?: string;
  step?: string;
  status?: string;
  data?: Record<string, unknown>;
}

interface Run {
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as NDJSON, for a --json run. */
  events: Event[];
  seconds: number;
}

interface Timing {
  step: string;
  seconds: number;
  status: "ok" | "failed";
}

const timings: Timing[] = [];
const runs: Run[] = [];
let tmp = "";
let appDir: string;
let appReady = false;

const describeRun = (run: Run) =>
  `everyapp ${run.args.join(" ")} (exit ${run.exitCode}${run.signal ? `, ${run.signal}` : ""})\n--- stdout ---\n${tail(run.stdout)}\n--- stderr ---\n${tail(run.stderr)}`;

function tail(output: string, lines = 40): string {
  return output.split("\n").slice(-lines).join("\n");
}

/**
 * The environment every run gets: the test's HOME (src/test/setup.ts set
 * it, so nothing touches the real ~/.everyapp), a git identity so create's
 * first commit is deterministic, no Cloudflare credentials or seam from the
 * machine, and none of vitest's own variables: the CLI never sets NODE_ENV
 * and Vite honours one already set, so a run that inherited NODE_ENV=test
 * would `release` a development build and run `cf dev` in test mode, not
 * what a person gets. `extra` on top; spawn drops the undefined entries.
 */
function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // VITEST, VITEST_MODE, VITEST_POOL_ID, VITEST_WORKER_ID, VITEST_VM_POOL, ...
  const vitest = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("VITEST"))
      .map((key) => [key, undefined]),
  );
  return {
    ...process.env,
    ...vitest,
    NODE_ENV: undefined,
    TEST: undefined,
    // vitest mirrors import.meta.env into process.env too.
    MODE: undefined,
    BASE_URL: undefined,
    DEV: undefined,
    PROD: undefined,
    SSR: undefined,
    NO_COLOR: "1",
    GIT_AUTHOR_NAME: "Built CLI test",
    GIT_AUTHOR_EMAIL: "built-cli@example.com",
    GIT_COMMITTER_NAME: "Built CLI test",
    GIT_COMMITTER_EMAIL: "built-cli@example.com",
    CLOUDFLARE_API_TOKEN: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
    EVERYAPP_GATEWAY_URL: undefined,
    EVERYAPP_CF_BINARY: undefined,
    EVERYAPP_CF_BRIDGE: undefined,
    ...extra,
  };
}

/**
 * Run the built CLI through its launcher with this Node, to the end. A
 * --json run's stdout is parsed once the process is gone, here in the
 * test's own async stack: thrown from the child's close listener, a
 * non-JSON line (the protocol violation this test exists to catch) would be
 * an uncaught exception, and the run would wait out its timeout instead of
 * failing at once with the line.
 */
async function everyapp(
  args: string[],
  {
    cwd,
    env,
    input,
    timeoutMs = 600_000,
  }: {
    cwd: string;
    env?: Record<string, string | undefined>;
    /** Piped to the child's stdin (what a script hands `configure`); none by default. */
    input?: string;
    timeoutMs?: number;
  },
): Promise<Run> {
  const began = Date.now();
  const exited = await new Promise<Pick<Run, "exitCode" | "signal" | "stdout" | "stderr">>((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      cwd,
      env: childEnv(env),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin!.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`everyapp ${args.join(" ")} ran past ${timeoutMs / 1000}s\n${tail(stdout)}\n${tail(stderr)}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(deadline);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
  const run: Run = {
    args,
    ...exited,
    events: args.includes("--json") ? parseEvents(exited, args) : [],
    seconds: (Date.now() - began) / 1000,
  };
  runs.push(run);
  return run;
}

/** Every stdout line of a --json run as an event, or the line that isn't one. */
function parseEvents({ stdout, stderr }: Pick<Run, "stdout" | "stderr">, args: string[]): Event[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(
          `everyapp ${args.join(" ")} wrote a non-JSON line to stdout: ${line}\n--- stderr ---\n${tail(stderr)}`,
        );
      }
      return event as Event;
    });
}

/**
 * The --json protocol (lib/output/events.ts): each event `v: 1` with a
 * known type, and the exit code set by the last event: 0 after done, 1
 * after an error (251/252 when the arguments were the problem), 2 after
 * an action_required.
 */
function expectProtocol(run: Run): Event {
  for (const event of run.events) {
    expect(event.v, describeRun(run)).toBe(1);
    expect(typeof event.ts, describeRun(run)).toBe("string");
    expect(EVENT_TYPES.has(event.type), `unknown event type ${event.type}\n${describeRun(run)}`).toBe(true);
  }
  const last = run.events.at(-1);
  expect(last, `wrote no events\n${describeRun(run)}`).toBeDefined();
  const allowed =
    last!.type === "done"
      ? [0]
      : last!.type === "action_required"
        ? [2]
        : last!.type === "error"
          ? [1, 251, 252]
          : [];
  expect(allowed, `ended on a ${last!.type} event\n${describeRun(run)}`).not.toEqual([]);
  expect(allowed, describeRun(run)).toContain(run.exitCode);
  return last!;
}

/** `work` with its time recorded under `step`, whether it passed or not. */
async function timed<T>(step: string, work: () => Promise<T>): Promise<T> {
  const began = Date.now();
  try {
    const result = await work();
    timings.push({ step, seconds: (Date.now() - began) / 1000, status: "ok" });
    return result;
  } catch (error) {
    timings.push({ step, seconds: (Date.now() - began) / 1000, status: "failed" });
    throw error;
  }
}

/** `work` over `items`, at most `width` at a time, results in order. */
async function inBatches<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await work(items[index]!);
      }
    }),
  );
  return results;
}

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/** One GET to the gateway-lite as `host`; the status, or null when nothing answered. */
function getStatus(port: number, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers: { host }, timeout: 30_000 },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? null));
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(null));
    request.end();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `manifest` with `block` as its last field: the starter ends in `});`
 * (`defineEveryApp({ ... })`) or `} as const;`, with or without a trailing
 * comma on the field before.
 */
function withLastField(manifest: string, block: string): string {
  const closing = /,?\s*\}(\)|\s*as const);?\s*$/;
  expect(manifest, "the starter manifest should end in `});` or `} as const;`").toMatch(closing);
  return manifest.replace(closing, (_match, end: string) => `,\n  ${block}\n}${end === ")" ? ")" : " as const"};\n`);
}

/** A fake Cloudflare account with a Gateway installed, reached by the built CLI through the cf seam. */
interface FakeGateway {
  account: FakeCloudflare;
  resources: Awaited<ReturnType<typeof ensureGatewayResources>>;
  /** What a run needs to reach it: the stand-in cf and its bridge. */
  env: Record<string, string>;
  /** Register an app as deployed and bound, with its Worker in the account, and make it live. */
  registerApp(manifest: { id: string } & Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/**
 * The fake account with a Gateway installed, as commands/status/status.test.ts
 * sets it up in process, behind a bridge: each call the stand-in cf receives
 * runs against the fake account's runner, and goes back as cf's stdout,
 * stderr and exit code (a CfError carries all three).
 */
async function fakeGateway(): Promise<FakeGateway> {
  const account = new FakeCloudflare();
  const events: Event[] = [];
  const sink = () => createNdjsonSink((line) => events.push(JSON.parse(line) as Event));
  const quick = { sleep: async () => undefined, leaseWaitMs: 0 };
  const tarball = await buildGatewayRelease();
  const release = await openRelease(tarball);
  const resources = await ensureGatewayResources(account.cf);
  const db = cfD1Database(account.cf, resources.d1Id);
  await applyGateway({
    cf: account.cf,
    out: sink(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: "example.com",
    resources,
    db,
    interactive: false,
    cliVersion: "0.3.0",
    ...quick,
  });
  const bridge = http.createServer(async (request, response) => {
    const body = JSON.parse(await text(request)) as {
      args: string[];
      json: boolean;
      accountId: string | null;
      files: Record<string, string>;
    };
    const reply = (answer: { stdout: string; stderr: string; exitCode: number }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    };
    try {
      const result = await account.cf.run({
        args: body.args,
        plane: "account",
        mode: body.json ? "json" : "text",
        env: body.accountId ? { CLOUDFLARE_ACCOUNT_ID: body.accountId } : {},
        files: body.files,
      });
      reply({ stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
    } catch (error) {
      if (error instanceof CfError) {
        reply({ stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode ?? 1 });
      } else {
        reply({ stdout: "", stderr: `┌ Error\n│ ${(error as Error).message}\n└\n`, exitCode: 1 });
      }
    }
  });
  const bridgeUrl = await new Promise<string>((resolve) =>
    bridge.listen(0, "127.0.0.1", () => {
      const address = bridge.address() as net.AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/`);
    }),
  );
  const standIn = path.join(tmp, "cf-stand-in.mjs");
  fs.writeFileSync(standIn, CF_STAND_IN);
  return {
    account,
    resources,
    env: { EVERYAPP_CF_BINARY: standIn, EVERYAPP_CF_BRIDGE: bridgeUrl },
    async registerApp(manifest) {
      const { plan } = await register(db, {
        appSlug: manifest.id,
        name: manifest.id,
        description: manifest.id,
        manifest,
        appBaseDomain: "example.com",
        deployer: { actor: "dev@example.com", email: "dev@example.com" },
        organizationName: "Acme",
      });
      await markDeployed(db, plan.app.id, { versionId: `${manifest.id}-v1`, manifest, actor: "dev@example.com" });
      account.workers.set(plan.app.workerName!, {
        versions: [`${manifest.id}-v1`],
        config: { name: plan.app.workerName, env: {} },
        secrets: {},
      });
      await reconcileGateway({
        cf: account.cf,
        out: sink(),
        accountId: ACCOUNT_ID,
        databaseId: resources.d1Id,
        openRelease: () => openRelease(tarball),
        interactive: false,
        cliVersion: "0.3.0",
        ...quick,
      });
      // The Gateway's first request for the app makes it live.
      await new GatewayWorker(account).fetch(`https://${manifest.id}.example.com/`);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
    },
    async close() {
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
      await release.cleanup();
    },
  };
}

describe.runIf(process.env["EVERYAPP_BUILT_CLI"] === "1")("the built CLI", { timeout: 600_000 }, () => {
  beforeAll(() => {
    expect(fs.existsSync(path.join(CLI_DIR, "dist", "index.js")), "dist/index.js: run pnpm -C packages/cli build first").toBe(true);
    // Outside the checkout, so create makes a standalone app that links the
    // checkout's packages by path, as it does for anyone else.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-built-cli-")));
    appDir = path.join(tmp, APP_ID);
  });

  afterAll(() => {
    // Without dist/, beforeAll stopped before mkdtemp: nothing to remove,
    // no timings to show (Math.max of none is -Infinity), only its message.
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (timings.length === 0) return;
    const width = Math.max(...timings.map((timing) => timing.step.length));
    console.log(
      [
        "built CLI timings",
        ...timings.map(
          (timing) => `  ${timing.step.padEnd(width)}  ${timing.seconds.toFixed(1).padStart(6)}s  ${timing.status}`,
        ),
        `  ${"total".padEnd(width)}  ${timings.reduce((sum, timing) => sum + timing.seconds, 0).toFixed(1).padStart(6)}s`,
      ].join("\n"),
    );
  });

  it("answers help for every route, its version, and an unknown command with one error event", () =>
    timed("help", async () => {
      const paths = commandPaths();
      expect(paths.length).toBeGreaterThan(20);
      const targets = [[], ["--help"], ...paths.map((route) => [...route.split(" "), "--help"])];
      const helps = await inBatches(targets, 4, (args) => everyapp(args, { cwd: tmp }));
      for (const run of helps) {
        expect(run.exitCode, describeRun(run)).toBe(0);
        expect(run.stdout.trim().length, `no help on stdout\n${describeRun(run)}`).toBeGreaterThan(0);
        expect(run.stderr, describeRun(run)).toBe("");
      }
      // The root help, with and without --help, names the groups and the flags.
      for (const run of helps.slice(0, 2)) {
        expect(run.stdout).toContain("BUILD AN APP");
        expect(run.stdout).toContain("RUN A GATEWAY");
        expect(run.stdout).toContain("--help");
      }

      const version = await everyapp(["--version"], { cwd: tmp });
      expect(version.exitCode, describeRun(version)).toBe(0);
      expect(version.stdout.trim()).toMatch(/^everyapp \d+\.\d+\.\d+/);

      const unknown = await everyapp(["frobnicate", "--json"], { cwd: tmp });
      expect(unknown.exitCode, describeRun(unknown)).toBe(251);
      expect(unknown.events, describeRun(unknown)).toHaveLength(1);
      expect(unknown.events[0]).toMatchObject({ v: 1, type: "error", code: "UNKNOWN_COMMAND", retryable: false });
      expect(unknown.events[0]!.message).toContain("frobnicate");
      expectProtocol(unknown);
    }));

  it("creates an app from the starter in a directory outside the checkout", () =>
    timed("create", async () => {
      // This commit's SDK and CLI, linked from the checkout: the published
      // range may name a version that isn't on npm yet (it is set before
      // publishing). Without the variable, create writes the range.
      const run = await everyapp(["create", APP_ID, "--json"], { cwd: tmp });
      const last = expectProtocol(run);
      expect(run.exitCode, describeRun(run)).toBe(0);
      expect(
        run.events.filter((event) => event.type === "error" || event.type === "warning"),
        describeRun(run),
      ).toEqual([]);
      expect(last).toMatchObject({ type: "done", data: { appId: APP_ID, dir: appDir } });
      const steps = run.events.filter((event) => event.type === "step" && event.status === "ok").map((event) => event.step);
      expect(steps).toEqual(
        expect.arrayContaining(["create.copy", "create.install", "create.types", "migrations.local", "create.git"]),
      );
      for (const file of [
        "everyapp.config.ts",
        "cloudflare.config.ts",
        "package.json",
        "node_modules/.pnpm",
        "node_modules/everyapp/package.json",
        "node_modules/@every-app/sdk/package.json",
        ".cloudflare/types/index.d.ts",
        ".git/HEAD",
      ]) {
        expect(fs.existsSync(path.join(appDir, file)), `${file} missing from the new app`).toBe(true);
      }
      // The template's workspace packages became links into this checkout.
      const packageJson = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")) as {
        name: string;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(packageJson.name).toBe(APP_ID);
      expect(packageJson.devDependencies["everyapp"]).toMatch(/^link:/);
      expect(packageJson.dependencies["@every-app/sdk"]).toMatch(/^link:/);
      expect(fs.realpathSync(path.join(appDir, "node_modules", "everyapp"))).toBe(fs.realpathSync(CLI_DIR));
      // Its lockfile is in its first commit.
      const tracked = spawnSync("git", ["ls-files", "pnpm-lock.yaml"], { cwd: appDir, encoding: "utf8" });
      expect(tracked.stdout.trim()).toBe("pnpm-lock.yaml");
      appReady = true;
    }));

  it("applies the local migrations with the starter manifest", () =>
    timed("db migrate", async () => {
      expect(appReady, "create failed above").toBe(true);
      const run = await everyapp(["db", "migrate", "--json"], { cwd: appDir });
      expectProtocol(run);
      expect(run.exitCode, describeRun(run)).toBe(0);
      expect(run.events.filter((event) => event.type === "error"), describeRun(run)).toEqual([]);
      // create applied the starter's migration already: up to date, or a skip; never a failure.
      const migrate = run.events.filter((event) => event.type === "step" && event.step === "db.migrate").at(-1);
      expect(migrate, describeRun(run)).toBeDefined();
      expect(["ok", "skip"], describeRun(run)).toContain(migrate!.status);
    }));

  it("serves the app through the gateway-lite under dev and stops on SIGINT", () =>
    timed("dev", async () => {
      expect(appReady, "create failed above").toBe(true);
      const port = await freePort();
      const host = `${APP_ID}.localhost:${port}`;
      const began = Date.now();
      let stdout = "";
      let stderr = "";
      const child: ChildProcess = spawn(process.execPath, [LAUNCHER, "dev", "--port", String(port)], {
        cwd: appDir,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
      );
      const output = () =>
        `everyapp dev --port ${port}\n--- stdout ---\n${tail(stdout, 60)}\n--- stderr ---\n${tail(stderr, 60)}`;
      try {
        // The first server-rendered page can take a while (vite compiles
        // the app on demand under workerd): until then, nothing listens,
        // or the gateway-lite answers with what vite has so far.
        const deadline = Date.now() + 240_000;
        let status: number | null = null;
        while (Date.now() < deadline) {
          if (child.exitCode !== null || child.signalCode !== null) break;
          status = await getStatus(port, host);
          if (status === 200) break;
          await sleep(1000);
        }
        expect(status, `no 200 from the dev app\n${output()}`).toBe(200);
        timings.push({ step: "dev: first 200", seconds: (Date.now() - began) / 1000, status: "ok" });
        expect(stdout, output()).toMatch(new RegExp(`App\\s+http://${APP_ID}\\.localhost:${port}`));
        expect(stdout, output()).toMatch(/MCP\s+http:\/\//);

        child.kill("SIGINT");
        const result = await Promise.race([
          exited,
          sleep(90_000).then(() => {
            throw new Error(`everyapp dev didn't exit within 90s of SIGINT\n${output()}`);
          }),
        ]);
        expect(result.code, output()).toBe(130);
      } finally {
        // Still up on the failure path. Through the CLI's own path first:
        // `cf dev` leads its own process group (lib/longRunning.ts), and a
        // SIGKILLed everyapp stops neither vite nor workerd. A first SIGINT
        // runs the interrupt cleanup, a second one kills the tracked group
        // without waiting (lib/interrupt.ts); SIGKILL comes last.
        for (const signal of ["SIGINT", "SIGINT", "SIGKILL"] as const) {
          if (child.exitCode !== null || child.signalCode !== null) break;
          child.kill(signal);
          await Promise.race([exited, sleep(5_000)]);
        }
        await exited;
      }
      expect(stderr, output()).not.toMatch(REBUILT);
    }));

  it("accepts capabilities without scope sets and refuses scopes where none exist (#543)", () =>
    timed("manifests", async () => {
      expect(appReady, "create failed above").toBe(true);
      const configPath = path.join(appDir, "everyapp.config.ts");
      const starter = fs.readFileSync(configPath, "utf8");
      expect(starter).toContain(`id: "${APP_ID}"`);

      // The bundled perimeter validates the manifest through jiti: the exact
      // path the built CLI refused on 2026-10-24.
      fs.writeFileSync(configPath, withLastField(starter, CAPABILITIES));
      const accepted = await everyapp(["db", "migrate", "--json"], { cwd: appDir });
      expectProtocol(accepted);
      expect(accepted.exitCode, describeRun(accepted)).toBe(0);
      expect(accepted.events.filter((event) => event.type === "error"), describeRun(accepted)).toEqual([]);

      fs.writeFileSync(configPath, withLastField(starter, NEGATIVE_CAPABILITIES));
      const refused = await everyapp(["db", "migrate", "--json"], { cwd: appDir });
      const last = expectProtocol(refused);
      expect(refused.exitCode, describeRun(refused)).toBe(1);
      expect(last).toMatchObject({ type: "error", code: "INVALID_MANIFEST" });
      expect(last.message, describeRun(refused)).toMatch(/capabilities\.members\.scopes/);
      expect(last.message, describeRun(refused)).toMatch(/takes no scopes/);

      // The same split could hide the `mcp` object: accepted as { by, why },
      // refused as the old string with the new shape named.
      fs.writeFileSync(configPath, withLastField(starter, MCP_OPT_IN));
      const optedIn = await everyapp(["db", "migrate", "--json"], { cwd: appDir });
      expectProtocol(optedIn);
      expect(optedIn.exitCode, describeRun(optedIn)).toBe(0);
      fs.writeFileSync(configPath, withLastField(starter, MCP_OLD_FORM));
      const oldForm = await everyapp(["db", "migrate", "--json"], { cwd: appDir });
      const oldFormLast = expectProtocol(oldForm);
      expect(oldForm.exitCode, describeRun(oldForm)).toBe(1);
      expect(oldFormLast).toMatchObject({ type: "error", code: "INVALID_MANIFEST" });
      expect(oldFormLast.message, describeRun(oldForm)).toMatch(/mcp is \{ by: "gateway" \| "app", why/);

      // The capability manifest stays for release.
      fs.writeFileSync(configPath, withLastField(starter, CAPABILITIES));
    }));

  it("packs a release of the app with the capability manifest", () =>
    timed("release", async () => {
      expect(appReady, "create failed above").toBe(true);
      const out = path.join(tmp, "release.tar.gz");
      const run = await everyapp(["release", "--json", "--out", out], { cwd: appDir });
      const last = expectProtocol(run);
      expect(run.exitCode, describeRun(run)).toBe(0);
      expect(run.events.filter((event) => event.type === "error"), describeRun(run)).toEqual([]);
      expect(last.type).toBe("done");
      const data = last.data as { tarball: string; shown: string; sha256: string; version: string };
      expect(typeof data.version).toBe("string");
      expect(data.tarball).toBe(out);
      expect(data.shown).toBe(out);
      expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(out), `no tarball at ${out}\n${describeRun(run)}`).toBe(true);
      const bytes = fs.readFileSync(out);
      // gzip's magic number.
      expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
      expect(bytes.length).toBeGreaterThan(1024);
      // The reader `install` uses opens it: the tree hash release.json
      // records (the sha256 the done event carries) holds, and the manifest
      // inside is the capability manifest, validated once more from source.
      const release = await openAppRelease(out);
      try {
        expect(release.release.sha256).toBe(data.sha256);
        expect(release.release.appId).toBe(APP_ID);
        expect(release.manifest.id).toBe(APP_ID);
        expect(Object.keys(release.manifest.capabilities ?? {}).sort()).toEqual(
          ["context", "dataforseo", "email", "members", "slack"],
        );
        expect(release.manifest.capabilities?.["slack"]).toMatchObject({
          access: "write",
          scopes: ["channels.read", "messages.write"],
        });
        expect(fs.existsSync(path.join(release.dir, "release.json"))).toBe(true);
        // A production build, not the development one a run that inherited
        // vitest's NODE_ENV=test would make (a quarter larger, and cf's
        // config.json calls it "production" either way, so the policy
        // check can't tell): React's production chunks carry its
        // minified-error prefix, its development ones the jsxDEV runtime.
        const chunksDir = path.join(release.dir, WORKERS_DIR, DEFAULT_WORKER, "bundle", "assets");
        const chunks = fs
          .readdirSync(chunksDir)
          .filter((name) => name.endsWith(".js"))
          .map((name) => ({ name, source: fs.readFileSync(path.join(chunksDir, name), "utf8") }));
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.some(({ source }) => source.includes("Minified React error"))).toBe(true);
        expect(chunks.filter(({ source }) => source.includes("jsxDEV")).map(({ name }) => name)).toEqual([]);
      } finally {
        await release.cleanup();
      }
    }));

  it("reports a Gateway's status from a fake Cloudflare account through the cf seam", () =>
    timed("status", async () => {
      const gateway = await fakeGateway();
      try {
        await gateway.registerApp({ id: REGISTERED_APP });
        const run = await everyapp(["status", "--json"], { cwd: tmp, env: gateway.env });
        const last = expectProtocol(run);
        expect(run.exitCode, describeRun(run)).toBe(0);
        expect(run.events.filter((event) => event.type === "error"), describeRun(run)).toEqual([]);
        expect(last.type).toBe("done");
        const data = last.data as {
          installed: boolean;
          gatewayUrl: string;
          accountId: string;
          apps: Array<{ id: string; status: string; bound: boolean }>;
        };
        expect(data.installed).toBe(true);
        expect(data.gatewayUrl).toBe("https://example.com");
        expect(data.accountId).toBe(ACCOUNT_ID);
        expect(data.apps.map((app) => app.id)).toEqual([REGISTERED_APP]);
        expect(data.apps[0]).toMatchObject({ status: "active", bound: true });
        expect(last.message).toContain("1 app live");
        // The built CLI asked who it was and read the Gateway's database through the stand-in.
        const calls = gateway.account.cf.calls.map((call) => call.args.join(" "));
        expect(calls).toContain("auth whoami");
        expect(calls.some((call) => call.startsWith(`d1 query ${gateway.resources.d1Id} --body @`))).toBe(true);
      } finally {
        await gateway.close();
      }
    }));

  it("configures an app from NAME=value lines on stdin through the cf seam, and refuses a value on the command line", () =>
    timed("configure", async () => {
      const gateway = await fakeGateway();
      try {
        // An app that needs two Gateway settings: a provider's key and a capability's.
        await gateway.registerApp({
          id: CONFIGURED_APP,
          providers: ["openrouter"],
          capabilities: { dataforseo: { access: "read", why: "Keyword data." } },
        });
        const secrets = () => gateway.account.workers.get("every-app-gateway")!.secrets;

        // One of the two, piped: set, and the warning names the other.
        const partial = await everyapp(["configure", CONFIGURED_APP, "--json"], {
          cwd: tmp,
          env: gateway.env,
          input: "# from a script\nOPENROUTER_API_KEY=sk-or-built\n",
        });
        const first = expectProtocol(partial);
        expect(partial.exitCode, describeRun(partial)).toBe(0);
        expect(first).toMatchObject({
          type: "done",
          message: `Set OPENROUTER_API_KEY. ${CONFIGURED_APP} still needs DATAFORSEO_API_KEY`,
          data: {
            app: { id: CONFIGURED_APP, deployed: true, setup: { ready: false } },
            set: ["OPENROUTER_API_KEY"],
            // "pnpm everyapp" under pnpm, "everyapp" run directly: the invocation the run had.
            next: [{ command: expect.stringMatching(new RegExp(`everyapp configure ${CONFIGURED_APP}$`)) }],
          },
        });
        expect(partial.events.filter((event) => event.type === "warning").map((event) => event.code)).toEqual(["APP_NEEDS_SETUP"]);
        expect(secrets()["OPENROUTER_API_KEY"]).toBe("sk-or-built");

        // The other, from the environment: ready.
        const rest = await everyapp(["configure", CONFIGURED_APP, "--from-env", "--json"], {
          cwd: tmp,
          env: { ...gateway.env, DATAFORSEO_API_KEY: "login:password" },
        });
        expectProtocol(rest);
        expect(rest.exitCode, describeRun(rest)).toBe(0);
        expect(rest.events.at(-1)).toMatchObject({
          type: "done",
          message: `Set DATAFORSEO_API_KEY. ${CONFIGURED_APP} is ready`,
          data: { set: ["DATAFORSEO_API_KEY"], app: { setup: { ready: true, command: null } } },
        });
        expect(rest.events.filter((event) => event.type === "warning"), describeRun(rest)).toEqual([]);
        expect(secrets()["DATAFORSEO_API_KEY"]).toBe("login:password");

        // Nothing piped, nothing to set: done, nothing changed.
        const ready = await everyapp(["configure", CONFIGURED_APP, "--json"], { cwd: tmp, env: gateway.env });
        expectProtocol(ready);
        expect(ready.exitCode, describeRun(ready)).toBe(0);
        expect(ready.events.at(-1)).toMatchObject({ type: "done", message: `${CONFIGURED_APP} is ready`, data: { set: [] } });

        // A name the app doesn't declare is refused before anything is written.
        const undeclared = await everyapp(["configure", CONFIGURED_APP, "--json"], {
          cwd: tmp,
          env: gateway.env,
          input: "STRIPE_KEY=sk_live\n",
        });
        const refusal = expectProtocol(undeclared);
        expect(undeclared.exitCode, describeRun(undeclared)).toBe(1);
        expect(refusal).toMatchObject({ type: "error", code: "SECRET_NOT_DECLARED" });
        expect(secrets()["STRIPE_KEY"]).toBeUndefined();

        // A value after the verb never goes anywhere.
        const argued = await everyapp(["configure", "DATAFORSEO_API_KEY=typed", "--json"], { cwd: tmp, env: gateway.env });
        const argument = expectProtocol(argued);
        expect(argued.exitCode, describeRun(argued)).toBe(1);
        expect(argument).toMatchObject({ type: "error", code: "VALUE_ON_COMMAND_LINE" });
        expect(secrets()["DATAFORSEO_API_KEY"]).toBe("login:password");
      } finally {
        await gateway.close();
      }
    }));

  it("never rebuilt dist/ on the way", () => {
    // The launcher rebuilds when src/ is newer than dist/: then the test
    // would have run a build of its own, not the one CI made.
    const rebuilt = runs.filter((run) => REBUILT.test(run.stderr));
    expect(rebuilt.map(describeRun)).toEqual([]);
    expect(runs.length).toBeGreaterThan(20);
  });
});
