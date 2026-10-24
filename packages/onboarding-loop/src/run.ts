/**
 * The driver (design 4.2): preflight, wipe, sandbox, checkout in from a git
 * bundle, the harness's turns with the scripted user and the owner claim
 * running beside them, the outside-in verifier, collect and redact, the
 * wipe again, the record. Every step's module is built and tested on its
 * own; this file orders them and threads the run directory, the redactor
 * and the clock through. Everything that touches a process, a socket or a
 * file comes in through RunDeps, so run.test.ts drives a whole run on fakes.
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AccountsError,
  configDir as defaultConfigDir,
  confirmPath,
  findAccount,
  loadAccountsFile,
  loadProviders,
  locksDir,
  refuseInheritedEnv,
  sha256,
  type RotateFile,
} from "./accounts";
import { assemble, type AssembleInput } from "./assemble";
import { createCfApi, type CfApi } from "./cf";
import {
  createEventLogClaimer,
  expireUnconsumedLinks,
  ownerCredentials,
  runD1Claimer,
  type ClaimerResult,
} from "./claim";
import { createAuthoritativeDns } from "./dns";
import {
  createDocker,
  imageTag,
  resolveDockerBinary,
  type Docker,
} from "./docker";
import { createEventFeed, type EventFeed } from "./eventFeed";
import { createGatewayD1 } from "./gatewayD1";
import {
  createHarness as defaultCreateHarness,
  HARNESS_BINARIES,
} from "./harnesses/index";
import { commandLineString } from "./harnesses/shared";
import { scriptFor, SCRIPT_PATH } from "./harnesses/script";
import { createHttpFetch } from "./httpFetch";
import { affectsDns, knownLocks, recordTeardown } from "./lock";
import {
  appFrom,
  everyappCommandsFrom,
  gatewayUploadedFrom,
  parseEventLog,
} from "./parse/eventLog";
import { formatChecks, runPreflight, type PreflightResult } from "./preflight";
import { promptSha256, promptText, type PromptVariant } from "./prompt";
import {
  emptyRunRecord,
  ensureRunDir,
  newRunId,
  RUN_FILES,
  writeRunRecord,
} from "./record";
import { createRedactor, exposed, type Redactor } from "./redact";
import { containerName } from "./sandbox";
import { CAPS, createScriptedUser, subdomainFor } from "./scriptedUser";
import { capture, spawnProcess, type Spawn } from "./spawn";
import {
  confirmFromTty,
  parseEvents,
  readConfirmFile,
  runTeardownStep,
  TeardownStepError,
  createRunMarker,
  removeRunMarker,
  type TeardownStepResult,
} from "./teardownStep";
import { runHarnessTurns, type TurnsResult } from "./turns";
import { verify, writeVerifyEvidence } from "./verify";
import {
  BUNDLE_PATH,
  CHECKOUT_PATH,
  createBundle,
  SiblingError,
  TokenGateError,
  withTestAccount,
  type Sibling,
} from "./withTestAccount";
import type {
  Account,
  Deviation,
  DiffEntry,
  EventLogLine,
  ExecLine,
  FetchLike,
  HarnessAdapter,
  HarnessMode,
  HarnessName,
  NormalizedEvent,
  Phase,
  ProviderVar,
  RunError,
  RunRecord,
  Sandbox,
  SandboxHandle,
  TerminalReason,
  VerifyResult,
} from "./types";

export { containerName };

export const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
export const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");
export const DOCKERFILE = path.join(PACKAGE_DIR, "Dockerfile");

/** Inside the container: where the loop's files live and where the event log is written. */
const LOOP_DIR = "/loop";
const EVENT_LOG_PATH = `${LOOP_DIR}/everyapp-events.ndjson`;
const PROMPT_PATH = `${LOOP_DIR}/prompt.txt`;
/** A string the template's signed-in page contains (templates/simple-todo, routes/index.tsx). */
export const TEMPLATE_MARKER = "Todos";
const CONTAINER_MEMORY = "6g";
const CONTAINER_MEMORY_MIB = 6 * 1024;
const STATS_INTERVAL_MS = 30_000;

/** The account the dry run uses when no accounts.json exists: nothing in it is real. */
const STUB_ACCOUNT: Account = {
  name: "stub",
  accountId: "0123456789abcdef0123456789abcdef",
  zone: "example.com",
  email: "owner@example.com",
  token: "stub-token-not-a-secret-00000000",
};

export interface RunOptions {
  harness: HarnessName;
  /** `--account`; the first account in the file when absent. */
  account: string | null;
  model: string | null;
  /** The commit under test, bundled into the harness's container and the verifier's. */
  ref: string;
  /** The commit the sibling containers run `everyapp teardown` from (this checkout's HEAD: the teardown PR is not on main yet). */
  toolsRef: string;
  mode: HarnessMode;
  withAccess: boolean;
  claimAfter: "immediate" | "turn-end";
  /** `--no-event-log`: the D1-side claim, as the control mode. */
  eventLog: boolean;
  promptVariant: PromptVariant;
  repeatOnInfra: number;
  keep: boolean;
  parallel: number;
  dryRun: boolean;
  /** Sleep through the 30-minute gap after the account's last wipe (default); `--no-wait` refuses instead. */
  waitForGap: boolean;
  retryOf: string | null;
}

export const DEFAULT_RUN_OPTIONS: Omit<RunOptions, "harness"> = {
  account: null,
  model: null,
  ref: "HEAD",
  toolsRef: "HEAD",
  mode: "defaults",
  withAccess: false,
  claimAfter: "immediate",
  eventLog: true,
  promptVariant: "checkout-present",
  repeatOnInfra: 0,
  keep: false,
  parallel: 1,
  dryRun: false,
  waitForGap: true,
  retryOf: null,
};

export interface RunDeps {
  configDir: string;
  runsRoot: string;
  repoRoot: string;
  dockerfile: string;
  docker: Docker | null;
  spawn: Spawn;
  createCf: (account: Account) => CfApi;
  /** The fetch the claim and the verifier use, pinned to the zone's authoritative nameservers. */
  createFetch: (zone: string) => FetchLike;
  /** Preflight's probe of https://everyapp.com/llms.txt; the global fetch by default. */
  docsFetch?: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Already redacted by the driver before it gets here. */
  log: (line: string) => void;
  /** The teardown's confirmation: the confirm file, else the id typed at /dev/tty. */
  confirm?: (account: Account) => Promise<string>;
  statsIntervalMs?: number;
  /** Keep the Mac awake for the run (darwin only). */
  caffeinate?: boolean;
  /** The adapter for a harness name; tests hand in a fake. */
  createHarness?: (name: HarnessName) => HarnessAdapter;
  /** Where SIGINT and SIGTERM come from and how the process ends after the cleanup they start; the process itself by default, nothing in tests unless one is handed in. */
  signals?: SignalSource;
}

/** A source of SIGINT and SIGTERM and the exit that follows their cleanup. */
export interface SignalSource {
  /** Registers the handler; returns what unregisters it. */
  on(handler: (signal: NodeJS.Signals) => void): () => void;
  exit(code: number): void;
}

const processSignals: SignalSource = {
  on(handler) {
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    };
  },
  exit: (code) => process.exit(code),
};

export function defaultRunDeps(log: (line: string) => void): RunDeps {
  const dir = defaultConfigDir();
  return {
    configDir: dir,
    runsRoot: path.join(dir, "runs"),
    repoRoot: REPO_ROOT,
    dockerfile: DOCKERFILE,
    docker: null,
    spawn: spawnProcess,
    createCf: (account) =>
      createCfApi({ token: account.token, accountId: account.accountId }),
    createFetch: () =>
      createHttpFetch({ lookup: createAuthoritativeDns().lookup }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    caffeinate: process.platform === "darwin",
    signals: processSignals,
  };
}

/** assemble-input.json: the run's inputs that no other artifact holds (the rest is re-read from events.jsonl, the event log and verify.json). */
export type SavedAssembleInput = Omit<
  AssembleInput,
  "seed" | "eventLog" | "processes" | "verify"
>;

class RunAbort extends Error {
  constructor(
    readonly terminal: TerminalReason,
    readonly error: RunError,
  ) {
    super(error.message);
    this.name = "RunAbort";
  }
}

interface RunOutcome {
  runId: string;
  record: RunRecord | null;
  exitCode: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Writes a text file only this user can read into the run directory. */
function writePrivate(dir: string, name: string, text: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** A value serialized, redacted as text, parsed back: the one way an in-memory object reaches a file. */
function redactJson<T>(redactor: Redactor, value: T): T {
  return JSON.parse(redactor.redact(JSON.stringify(value))) as T;
}

/**
 * The harness ran `everyapp deploy` and its next tool result was not an
 * error: the fallback for "did the harness deploy" when the commit under
 * test has no event-log seam. The verifier still proves the app from outside.
 */
function deployedByToolCalls(events: NormalizedEvent[]): boolean {
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind !== "tool_call") continue;
    const words = [...(event.argv ?? []), ...(event.text ?? "").split(/\s+/)];
    const everyapp = words.findIndex(
      (w) => w === "everyapp" || w.endsWith("/everyapp"),
    );
    if (everyapp === -1 || words[everyapp + 1] !== "deploy") continue;
    const result = events
      .slice(i + 1)
      .find((e) => e.kind === "tool_result" || e.kind === "tool_call");
    if (result?.kind === "tool_result" && !result.isError) return true;
  }
  return false;
}

/** Files over this are not read into memory: they are replaced by a note instead of left unredacted. */
const REDACT_MAX_BYTES = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

/** A NUL byte in the first 8 KiB: not text, so not rewritten (a sqlite store would be corrupted). */
function looksBinary(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const read = fs.readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Every regular text file under `dir` rewritten through the redactor
 * (collected session stores may hold what an agent echoed). An oversize
 * file is replaced by a one-line note rather than kept unredacted; a
 * binary file is left as it is and named in the log.
 */
export function redactTree(
  dir: string,
  redactor: Redactor,
  log: (line: string) => void = () => undefined,
): number {
  let files = 0;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const stat = fs.statSync(file);
        if (stat.size > REDACT_MAX_BYTES) {
          fs.writeFileSync(
            file,
            `[not collected: ${stat.size} bytes is over the ${REDACT_MAX_BYTES}-byte limit for redaction]\n`,
          );
          log(`not collected (too large to redact): ${file}`);
          continue;
        }
        if (stat.size > 0 && looksBinary(file)) {
          log(`left as is (binary, not redacted): ${file}`);
          continue;
        }
        const text = fs.readFileSync(file, "utf8");
        const redacted = redactor.redact(text);
        if (redacted !== text) fs.writeFileSync(file, redacted);
        files += 1;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files;
}

/** The commit a ref names, its CLI version, whether the agent docs and the event-log seam are in it. */
export async function describeRef(
  spawn: Spawn,
  repoRoot: string,
  ref: string,
): Promise<{
  commit: string;
  cliVersion: string;
  agentDocs: boolean;
  eventLogSeam: boolean;
}> {
  const revision = await capture(
    spawn,
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    {
      cwd: repoRoot,
    },
  );
  if (revision.code !== 0)
    throw new Error(`git rev-parse ${ref}: ${revision.stderr.join(" ")}`);
  const commit = revision.stdout[0]!;
  const pkg = await capture(
    spawn,
    "git",
    ["show", `${commit}:packages/cli/package.json`],
    {
      cwd: repoRoot,
    },
  );
  let cliVersion = "unknown";
  try {
    cliVersion = String(
      (JSON.parse(pkg.stdout.join("\n")) as { version?: string }).version ??
        "unknown",
    );
  } catch {
    // No package.json at that commit: the version stays unknown.
  }
  const docs = await capture(
    spawn,
    "git",
    ["cat-file", "-e", `${commit}:landing-page/content/agent/index.md`],
    { cwd: repoRoot },
  );
  const seam = await capture(
    spawn,
    "git",
    [
      "grep",
      "-q",
      "-e",
      "EVERYAPP_EVENT_LOG",
      commit,
      "--",
      "packages/cli/src",
    ],
    { cwd: repoRoot },
  );
  return {
    commit,
    cliVersion,
    agentDocs: docs.code === 0,
    eventLogSeam: seam.code === 0,
  };
}

async function ensureImage(
  docker: Docker,
  dockerfile: string,
  log: (l: string) => void,
): Promise<string> {
  const tag = imageTag(dockerfile);
  if (!(await docker.imageExists(tag))) {
    log(`building ${tag} (first time; a few minutes)`);
    const { ms } = await docker.build({
      dockerfile,
      context: path.dirname(dockerfile),
      tag,
    });
    log(`built ${tag} in ${Math.round(ms / 1000)} s`);
  }
  return tag;
}

/** The whole run; the per-run work is `runOnce`, repeated for `--repeat-on-infra`. */
export async function runLoop(
  options: RunOptions,
  deps: RunDeps,
): Promise<RunOutcome> {
  let outcome = await runOnce(options, deps);
  let repeats = options.repeatOnInfra;
  while (
    repeats > 0 &&
    outcome.record?.verdict.value === "fail-infra" &&
    !options.dryRun
  ) {
    repeats -= 1;
    deps.log(
      `fail-infra (${outcome.record.verdict.reasonCode}): running again (--repeat-on-infra)`,
    );
    outcome = await runOnce({ ...options, retryOf: outcome.runId }, deps);
  }
  return outcome;
}

async function runOnce(
  options: RunOptions,
  deps: RunDeps,
): Promise<RunOutcome> {
  refuseInheritedEnv();
  if (options.mode === "raised") {
    throw new Error(
      "mode raised (one long-lived stream-json process) is not built; run mode defaults.",
    );
  }
  const adapter = (deps.createHarness ?? defaultCreateHarness)(options.harness);
  const model = options.model ?? adapter.defaultModel;

  // 1. The account and the provider key, or the stub for a dry run.
  let account = STUB_ACCOUNT;
  let provider: { name: ProviderVar; value: string } | null = null;
  let stub = false;
  try {
    // `--account stub --dry-run` is the stub whether or not accounts.json exists.
    if (options.dryRun && options.account === "stub")
      throw new AccountsError("file_missing", "stub requested");
    const accounts = loadAccountsFile(deps.configDir);
    account = findAccount(
      accounts,
      options.account ?? accounts.accounts[0]!.name,
    );
    const providers = loadProviders(deps.configDir);
    if (adapter.providerVar) {
      const value = providers[adapter.providerVar];
      if (!value && !options.dryRun)
        throw new AccountsError(
          "file_invalid",
          `${adapter.providerVar} is not in providers.env; the ${adapter.name} harness needs it.`,
        );
      if (value) provider = { name: adapter.providerVar, value };
    }
  } catch (error) {
    if (
      !(
        error instanceof AccountsError &&
        error.code === "file_missing" &&
        options.dryRun
      )
    )
      throw error;
    stub = true;
  }
  const redactor = createRedactor([
    { name: "cf_token", value: account.token },
    ...(provider
      ? [{ name: "provider_key" as const, value: provider.value }]
      : []),
  ]);
  const log = (line: string): void => deps.log(redactor.redact(line));
  if (stub)
    log(
      `no accounts.json in ${deps.configDir}: using the stub account (nothing in it is real)`,
    );
  else
    log(
      `account ${account.name} (zone ${account.zone}) from ${deps.configDir}`,
    );

  const docker =
    deps.docker ??
    (() => {
      const binary = resolveDockerBinary();
      return binary ? createDocker({ binary, redact: redactor.redact }) : null;
    })();
  const startedMs = deps.now();
  const runId = newRunId(new Date(startedMs), options.harness, model);
  const cf = options.dryRun ? null : deps.createCf(account);
  const image = imageTag(deps.dockerfile);

  // 2. Preflight.
  const preflight = await runPreflight({
    account,
    runId,
    dryRun: options.dryRun,
    parallel: options.parallel,
    image,
    configDir: deps.configDir,
    docker,
    cf,
    provider,
    spawn: deps.spawn,
    now: deps.now,
    ...(deps.docsFetch ? { fetch: deps.docsFetch } : {}),
    ...(options.waitForGap && !options.dryRun
      ? { waitForGap: { sleep: deps.sleep, log } }
      : {}),
  });
  for (const line of formatChecks(preflight.checks)) log(line);
  if (options.dryRun) {
    preflight.release();
    log(
      preflight.ok
        ? `preflight ok (dry run: nothing was created, no network call was made); harness ${adapter.name} would run ${commandLineString(adapter.command({ promptPath: PROMPT_PATH, model: model ?? undefined, zone: account.zone, loopDir: LOOP_DIR }).argv)}`
        : `preflight failed: ${preflight.reasonCode}`,
    );
    return { runId, record: null, exitCode: preflight.ok ? 0 : 1 };
  }

  const runDir = ensureRunDir(deps.runsRoot, runId);
  const run = new RunState(options, deps, {
    account,
    adapter,
    model,
    provider,
    redactor,
    log,
    docker,
    cf: cf!,
    runId,
    runDir,
    startedMs,
    preflight,
    image,
  });
  // Ctrl-C or a kill: the container with the secrets in its env goes, so does every sibling
  // still running, the run's marker, every open link, then the wipe, the record and the lock,
  // then exit 130. Nothing exits before cleanup() has finished: the main path below awaits the
  // same cleanup, and the exit here comes after it. Node would otherwise just die.
  const onSignal = (signal: NodeJS.Signals): void => {
    log(
      `${signal}: cleaning up (container, siblings, marker, links, teardown, record, lock), then exiting 130`,
    );
    run.kill(signal);
    void (async () => {
      try {
        await run.cleanup();
      } catch (error) {
        log(`cleanup after ${signal} failed: ${(error as Error).message}`);
      }
      try {
        run.finish();
      } catch (error) {
        log(`no record after ${signal}: ${(error as Error).message}`);
      }
      preflight.release();
      deps.signals?.exit(130);
    })();
  };
  const offSignals = deps.signals?.on(onSignal);
  try {
    if (!preflight.ok) {
      run.terminal = "preflight_failed";
      run.errors.push({
        code: preflight.reasonCode ?? "preflight_failed",
        step: "preflight",
        source: "infra",
        message:
          preflight.checks.find((c) => c.status === "fail")?.detail ??
          "preflight failed",
      });
    } else {
      await run.execute();
    }
  } catch (error) {
    run.fail(error);
  } finally {
    await run.cleanup();
    preflight.release();
    offSignals?.();
  }
  const record = run.finish();
  return {
    runId,
    record,
    exitCode: record.verdict.value.startsWith("pass") ? 0 : 1,
  };
}

interface RunContext {
  account: Account;
  adapter: HarnessAdapter;
  model: string | null;
  provider: { name: ProviderVar; value: string } | null;
  redactor: Redactor;
  log: (line: string) => void;
  docker: Docker | null;
  cf: CfApi;
  runId: string;
  runDir: string;
  startedMs: number;
  preflight: PreflightResult;
  image: string;
}

/** One run's mutable state, so `execute`, `cleanup` and `finish` read the same things whatever step threw. */
class RunState {
  terminal: TerminalReason | null = null;
  errors: RunError[] = [];
  preRunPlanTotal = 0;
  turns: TurnsResult | null = null;
  readonly user: ReturnType<typeof createScriptedUser>;
  claim: ClaimerResult = {
    how: "none",
    linkEmittedAt: null,
    claimedAt: null,
    latencyS: null,
    harnessSelfClaimed: false,
  };
  verifyResult: VerifyResult | null = null;
  verifierInconclusive = false;
  dnsNegativeCache = false;
  statsPeakMiB: number | null = null;
  toolEnv: RunRecord["toolEnv"] | null = null;
  extraPhases: Phase[] = [];
  deviations: Deviation[] = ["checkout_preplaced", "api_token_auth"];
  seed: RunRecord | null = null;
  handle: SandboxHandle | null = null;
  sandbox: Sandbox | null = null;
  toolsBundle: string | null = null;
  testBundle: string | null = null;
  tempDir: string;
  eventLogSeam = false;
  diffEntries: DiffEntry[] = [];
  /** `git status --porcelain` over the taint roots in the harness's checkout, when it ran. */
  gitStatus: string[] | null = null;
  /** `setup` processes found dead with no exit line while a reply was held for them. */
  readonly backgroundKills: Array<{ at: string; pid: number }> = [];
  /** The one cleanup pass; every caller (the finally, a signal) awaits the same one. */
  private cleanupPromise: Promise<void> | null = null;
  /** Sibling containers alive right now (a wipe or the verifier in progress), by name. */
  private readonly siblings = new Map<string, SandboxHandle>();
  /** The signal that stopped the run, when one did. */
  killedBy: NodeJS.Signals | null = null;
  /** Aborted by kill() while the run is still going: a sibling created after it is destroyed at once. */
  private readonly stopped = new AbortController();
  private finished: RunRecord | null = null;
  /** Replies decided from the event log (the subdomain PUT's "Done, continue", the Access team), delivered at the next turn end. */
  private readonly queuedReplies: string[] = [];
  /** Work started from the event log that a turn end waits for (the subdomain PUT and its settle). */
  private pendingWork: Promise<void> = Promise.resolve();
  /** The CLI's event log as the tail delivered it, parsed for the scripted user and kept for the record. */
  readonly feed: EventFeed;
  /** The same log as `docker cp` took it out of the container after the harness ended: complete where the tail's last lines were not. */
  private completeEventLog: EventLogLine[] | null = null;
  readonly owner: ReturnType<typeof ownerCredentials>;
  readonly gatewayOrigin: string;
  readonly d1: ReturnType<typeof createGatewayD1>;
  private markerCreated = false;
  private containerRemoved = false;
  private caffeinatePid: number | null = null;

  constructor(
    readonly options: RunOptions,
    readonly deps: RunDeps,
    readonly ctx: RunContext,
  ) {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-loop-run-"));
    fs.chmodSync(this.tempDir, 0o700);
    // The sleep through the wipe gap is a phase of the record; durationS leaves it out.
    if (ctx.preflight.gapWait) this.extraPhases.push(ctx.preflight.gapWait);
    this.user = createScriptedUser({
      zone: ctx.account.zone,
      accountName: ctx.account.name,
      withAccess: options.withAccess,
      claimAfter: options.claimAfter,
      now: () => new Date(deps.now()),
    });
    this.feed = createEventFeed({
      onInput: (input) => {
        const action = this.user.onInput(input);
        if (input.kind === "action_required")
          ctx.log(`everyapp action_required ${input.action}`);
        if (input.kind === "cli_error") ctx.log(`everyapp error ${input.code}`);
        if (action?.type === "fixture_error")
          ctx.log(
            `fixture error ${action.code}: the run stops at the next turn end`,
          );
        if (action?.type === "reply") this.queuedReplies.push(action.text);
        if (action?.type === "register_workers_subdomain") {
          ctx.log(
            `registering the workers.dev subdomain ${action.subdomain} (REST PUT), then "${action.thenReply}"`,
          );
          this.pendingWork = this.pendingWork
            .then(() => ctx.cf.putWorkersSubdomain(action.subdomain))
            .then(() => deps.sleep(CAPS.subdomainSettleSeconds * 1000))
            .then(() => {
              if (this.seed) this.seed.fixtures.workers_subdomain = "first-run";
              this.queuedReplies.push(action.thenReply);
            })
            .catch((error: unknown) => {
              ctx.log(`the subdomain PUT failed: ${(error as Error).message}`);
              this.errors.push({
                code: "workers_subdomain_put_failed",
                step: "setup.gateway",
                source: "infra",
                message: `${(error as Error).message}`.slice(0, 300),
              });
            });
        }
      },
      onSetupInvocation: (pid) => {
        void this.readToolEnv(pid);
      },
    });
    this.owner = ownerCredentials(ctx.account.email);
    this.gatewayOrigin = `https://apps.${ctx.account.zone}`;
    this.d1 = createGatewayD1(ctx.cf);
    ctx.redactor.add({ name: "owner_password", value: this.owner.password });
  }

  private get log() {
    return this.ctx.log;
  }

  /**
   * A signal stopped the run: the terminal reason stays `killed` whatever
   * the interrupted step throws next. Once the run has ended on its own and
   * its cleanup is under way (the post-run wipe, say), the signal changes
   * nothing about what the run was: the record keeps its verdict, the
   * signal path waits for the same cleanup and exits 130.
   */
  kill(signal: NodeJS.Signals): void {
    if (this.killedBy) return;
    this.killedBy = signal;
    if (this.cleanupPromise) {
      this.log(
        `${signal} during the cleanup after the run: the record keeps what the run was`,
      );
      return;
    }
    this.stopped.abort(
      new RunAbort("killed", {
        code: "killed",
        step: null,
        source: "loop",
        message: `${signal}: stopped while a container was created`,
      }),
    );
    this.terminal = "killed";
    this.errors.push({
      code: "killed",
      step: null,
      source: "loop",
      message: `${signal}: the driver was stopped before the run ended`,
    });
  }

  fail(error: unknown): void {
    if (this.killedBy) {
      // The step the signal interrupted threw (its container is gone): the kill is the reason, not this.
      this.log(`after ${this.killedBy}: ${(error as Error).message ?? error}`);
      return;
    }
    if (error instanceof RunAbort) {
      this.terminal = error.terminal;
      this.errors.push(error.error);
      this.log(`${error.terminal}: ${error.message}`);
      return;
    }
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.terminal = "driver_error";
    this.errors.push({
      code:
        error instanceof TokenGateError
          ? error.gate.code
          : error instanceof SiblingError
            ? "sibling_failed"
            : "driver_error",
      step: null,
      source: error instanceof TokenGateError ? "infra" : "loop",
      message: message.slice(0, 500),
    });
    this.log(`driver error: ${message}`);
  }

  /** Between steps: a signal has arrived, so nothing more is started (cleanup() is already running). */
  private stopIfKilled(): void {
    if (this.killedBy)
      throw new RunAbort("killed", {
        code: "killed",
        step: null,
        source: "loop",
        message: `${this.killedBy}: stopped between steps`,
      });
  }

  /** The run, in order; anything thrown lands in fail() and cleanup() still runs. */
  async execute(): Promise<void> {
    const { log, docker, account, adapter } = this.ctx;
    if (!docker)
      throw new Error("docker: not found at Docker Desktop's paths or on PATH");
    this.keepAwake();

    // 3. The two bundles and what the commit under test carries.
    const tools = await describeRef(
      this.deps.spawn,
      this.deps.repoRoot,
      this.options.toolsRef,
    );
    const test = await describeRef(
      this.deps.spawn,
      this.deps.repoRoot,
      this.options.ref,
    );
    this.toolsBundle = path.join(this.tempDir, "tools.bundle");
    this.testBundle = path.join(this.tempDir, "test.bundle");
    await createBundle(
      this.deps.spawn,
      this.deps.repoRoot,
      this.options.toolsRef,
      this.toolsBundle,
    );
    if (test.commit === tools.commit)
      fs.copyFileSync(this.toolsBundle, this.testBundle);
    else
      await createBundle(
        this.deps.spawn,
        this.deps.repoRoot,
        this.options.ref,
        this.testBundle,
      );
    this.eventLogSeam = this.options.eventLog && test.eventLogSeam;
    log(
      `checkout ${this.options.ref} (${test.commit.slice(0, 8)}, cli ${test.cliVersion}, agent docs ${test.agentDocs ? "present" : "absent"}, event log seam ${test.eventLogSeam ? "present" : "absent"}); tools from ${this.options.toolsRef} (${tools.commit.slice(0, 8)})`,
    );
    if (!this.eventLogSeam) {
      log(
        this.options.eventLog
          ? "WARNING: the commit under test has no EVERYAPP_EVENT_LOG seam: the owner claim runs D1-side (deviation d1_claim), the scripted user cannot see setup start or end, and the app comes from status --json, not the CLI's own events"
          : "--no-event-log: the owner claim runs D1-side (deviation d1_claim)",
      );
      this.deviations.push("d1_claim");
    } else {
      this.deviations.push("event_log");
    }
    if (this.options.claimAfter === "immediate")
      this.deviations.push("claim_immediate");
    if (adapter.name === "claude")
      this.deviations.push("claude_consent_seeded");

    const image = await ensureImage(docker, this.deps.dockerfile, log);
    const prompt = promptText(this.options.promptVariant);
    writePrivate(this.ctx.runDir, RUN_FILES.prompt, prompt);
    const launchCommand = adapter.command({
      promptPath: PROMPT_PATH,
      model: this.ctx.model ?? undefined,
      zone: account.zone,
      loopDir: LOOP_DIR,
    });
    const info = this.ctx.preflight.docker;
    this.seed = {
      ...emptyRunRecord({
        runId: this.ctx.runId,
        startedAt: iso(this.ctx.startedMs),
        accountName: account.name,
        harness: {
          name: adapter.name,
          version: adapter.version,
          model: { requested: this.ctx.model, resolved: null },
          mode: adapter.name === "claude" ? this.options.mode : null,
          commandLine: commandLineString(launchCommand.argv),
          permissionBypass: true,
        },
        signal: adapter.signal,
        checkout: { commit: test.commit, ref: this.options.ref, how: "bundle" },
        cli: { commit: test.commit, version: test.cliVersion },
        prompt: {
          variant: this.options.promptVariant,
          sha256: promptSha256(prompt),
        },
        substrate: {
          kind: "docker",
          engine: info?.engine ?? "",
          image: { tag: image, platform: "linux/arm64" },
          vmMemoryGiB: info
            ? Math.round((info.memBytes / 1024 ** 3) * 100) / 100
            : null,
          statsPeakMiB: null,
        },
      }),
      retryOf: this.options.retryOf,
      agentDocs: {
        present: test.agentDocs,
        commit: test.agentDocs ? test.commit : null,
      },
    };
    this.seed.fixtures = {
      ...this.seed.fixtures,
      workers_subdomain: this.ctx.preflight.fixtures.workers_subdomain,
      docs_url: this.ctx.preflight.fixtures.docs_url,
      cert_packs: "deleted",
      team: this.options.withAccess ? subdomainFor(account.name) : "n/a",
    };

    // 4. The wipe, then the run marker.
    const before = await this.teardown("before", RUN_FILES.inventoryBefore);
    this.preRunPlanTotal = before.after.total;
    log(
      `wiped: ${before.before.total} resource(s) before, ${before.after.total} after, dns leftovers ${before.dnsLeftovers.length}`,
    );
    this.stopIfKilled();
    await createRunMarker(this.ctx.cf, this.ctx.runId);
    this.markerCreated = true;

    // 5. The sandbox with exactly the secrets it needs, the checkout, the prompt.
    const env: Record<string, string> = {
      CLOUDFLARE_API_TOKEN: account.token,
      CLOUDFLARE_ACCOUNT_ID: account.accountId,
      ...(this.ctx.provider
        ? { [this.ctx.provider.name]: this.ctx.provider.value }
        : {}),
      EVERYAPP_EVENT_LOG: EVENT_LOG_PATH,
    };
    this.sandbox = docker.sandbox;
    this.handle = await this.sandbox.create({
      name: containerName(this.ctx.runId),
      image,
      platform: "linux/arm64",
      cpus: 4,
      memory: CONTAINER_MEMORY,
      env,
      user: "dev",
      workdir: "/work",
    });
    // A signal while the create was in flight: cleanup() looked before the handle existed, so the
    // container with the token in its env goes now, not at the re-sweep.
    if (this.killedBy) await this.removeContainer();
    this.stopIfKilled();
    const sandbox = this.sandbox;
    const handle = this.handle;
    await sandbox.copyIn(handle, this.testBundle, BUNDLE_PATH);
    const clone = await this.exec([
      "git",
      "clone",
      "-q",
      BUNDLE_PATH,
      CHECKOUT_PATH,
    ]);
    if (clone.exitCode !== 0)
      throw new RunAbort("driver_error", {
        code: "clone_failed",
        step: "checkout",
        source: "loop",
        message: `git clone of the bundle exited ${clone.exitCode}`,
      });
    await sandbox.copyIn(
      handle,
      this.tempFile("prompt.txt", prompt),
      PROMPT_PATH,
    );
    if (adapter.name === "script") {
      const script = scriptFor({ zone: account.zone, loopDir: LOOP_DIR });
      await sandbox.copyIn(
        handle,
        this.tempFile("script.sh", script),
        SCRIPT_PATH,
      );
    }
    const version = await this.exec([
      HARNESS_BINARIES[adapter.name],
      "--version",
    ]);
    const versionLine = version.lines.find((l) => l.trim())?.trim() ?? null;
    if (versionLine && adapter.version === "installer")
      this.seed.harness.version = versionLine.slice(0, 60);
    log(
      `${adapter.name}: ${versionLine ?? "no --version"}; container ${handle.name}`,
    );
    // Design 4.3: every binary's --version and `ls -la $HOME` per run, so an installer-based
    // harness rebuilt under the same image tag, or a seeded file, shows in the record.
    const versions = await this.exec([
      "bash",
      "-c",
      'for b in node pnpm git claude codex opencode agent hermes; do printf "%s " "$b"; "$b" --version 2>&1 | head -n 1; done; echo; ls -la "$HOME"',
    ]);
    writePrivate(
      this.ctx.runDir,
      RUN_FILES.versions,
      this.ctx.redactor.redact(`${versions.lines.join("\n")}\n`),
    );

    // 6. The event log tail, the claimer and the stats sampler run beside the harness.
    const eventsFile = path.join(this.ctx.runDir, RUN_FILES.events);
    const stdoutFile = path.join(this.ctx.runDir, RUN_FILES.harnessStdout);
    const stderrFile = path.join(this.ctx.runDir, RUN_FILES.harnessStderr);
    const rawLinesFile = path.join(this.ctx.runDir, RUN_FILES.harnessRaw);
    const rawLogFile = path.join(this.ctx.runDir, RUN_FILES.eventLog);
    for (const file of [
      eventsFile,
      stdoutFile,
      stderrFile,
      rawLinesFile,
      rawLogFile,
    ])
      fs.writeFileSync(file, "", { mode: 0o600 });
    const fetchImpl = this.deps.createFetch(account.zone);
    const claimerOptions = {
      fetchImpl,
      gatewayOrigin: this.gatewayOrigin,
      owner: this.owner,
      sleep: this.deps.sleep,
      now: () => new Date(this.deps.now()),
      onEvent: (event: { type: string; how: string }) =>
        log(`claim (${event.how}): ${event.type}`),
    };
    const claimer = this.eventLogSeam
      ? createEventLogClaimer(claimerOptions)
      : null;
    // --claim-after turn-end: lines are held until the turn that showed the link ends (onTurnEnd),
    // so the record measures whether the agent relayed the link and waited; immediate: no holding.
    let claimGateOpen = this.options.claimAfter === "immediate";
    const heldLines: string[] = [];
    const tail = await sandbox.tailFile(handle, EVENT_LOG_PATH, (line) => {
      fs.appendFileSync(rawLogFile, `${this.ctx.redactor.redact(line)}\n`);
      this.feed.onLine(line);
      if (!claimer) return;
      if (claimGateOpen) claimer.onLine(line);
      else heldLines.push(line);
    });
    const openClaimGate = async (): Promise<void> => {
      claimGateOpen = true;
      if (!claimer) return;
      for (const line of heldLines.splice(0)) claimer.onLine(line);
      await claimer.settle();
    };
    let d1Stopped = false;
    class ClaimerStopped extends Error {}
    const d1Claim = claimer
      ? null
      : runD1Claimer({
          ...claimerOptions,
          d1: this.d1,
          sleep: (ms) =>
            d1Stopped
              ? Promise.reject(new ClaimerStopped("stopped"))
              : this.deps.sleep(ms),
        }).catch((error: unknown) => {
          // The stop is the normal end; anything else (a D1 5xx, a malformed row) is an infra error the record names.
          if (error instanceof ClaimerStopped) return null;
          const message = `${(error as Error).message}`.slice(0, 300);
          this.errors.push({
            code: "d1_claim_failed",
            step: "setup.owner",
            source: "infra",
            message,
          });
          log(`the D1-side claimer failed: ${message}`);
          return null;
        });
    const sample = (): Promise<void> =>
      docker.memoryMiB(handle.name).then(
        (mib) => {
          if (mib === null) return;
          fs.appendFileSync(
            path.join(this.ctx.runDir, RUN_FILES.stats),
            `${JSON.stringify({ at: iso(this.deps.now()), memMiB: mib })}\n`,
          );
          this.statsPeakMiB = Math.max(this.statsPeakMiB ?? 0, mib);
        },
        () => undefined,
      );
    const firstSample = sample();
    const stats = setInterval(
      () => void sample(),
      this.deps.statsIntervalMs ?? STATS_INTERVAL_MS,
    );

    // 7. The harness's turns. The 90 minutes start here, not at the driver's start: the image build
    // and the pre-run wipe are the driver's time, recorded as their own phases.
    const harnessStartedMs = this.deps.now();
    const deadlineAt = harnessStartedMs + CAPS.runMinutes * 60_000;
    let replyIndex = 0;
    try {
      this.turns = await runHarnessTurns({
        sandbox,
        handle,
        adapter,
        launch: {
          promptPath: PROMPT_PATH,
          model: this.ctx.model ?? undefined,
          zone: account.zone,
          loopDir: LOOP_DIR,
        },
        user: this.user,
        cwd: CHECKOUT_PATH,
        writeReply: async (index, text) => {
          replyIndex = index;
          const inside = `${LOOP_DIR}/reply-${index}.txt`;
          await sandbox.copyIn(
            handle,
            this.tempFile(`reply-${index}.txt`, `${text}\n`),
            inside,
          );
          log(`reply ${index}: ${text.slice(0, 120)}`);
          return inside;
        },
        takeQueuedReplies: async () => {
          await this.pendingWork;
          return this.queuedReplies.splice(0);
        },
        onEvent: (event, processIndex) => {
          fs.appendFileSync(
            eventsFile,
            `${this.ctx.redactor.redact(JSON.stringify({ processIndex, ...event }))}\n`,
          );
          if (event.kind === "tool_call" && event.text)
            log(`${adapter.name} ran: ${event.text.slice(0, 160)}`);
          if (event.kind === "result")
            log(`${adapter.name} turn ended (${event.stopReason ?? "result"})`);
        },
        onRawLine: (line: ExecLine, processIndex) => {
          const redacted = this.ctx.redactor.redact(line.line);
          fs.appendFileSync(
            line.stream === "stdout" ? stdoutFile : stderrFile,
            `${redacted}\n`,
          );
          // Per process and stream, so `loop reparse` can run a newer normalizer over the same lines.
          fs.appendFileSync(
            rawLinesFile,
            `${JSON.stringify({ processIndex, stream: line.stream, receivedAt: line.receivedAt, line: redacted })}\n`,
          );
        },
        takePersonAnswer: () => this.takePersonAnswer(),
        onTurnEnd: async () => {
          if (!claimGateOpen) await openClaimGate();
        },
        onWaitPoll: () => this.checkSetupAlive(),
        deadlineAt,
        now: this.deps.now,
        sleep: this.deps.sleep,
      });
      log(
        `harness ended: ${this.turns.terminal}${this.turns.fixtureCode ? ` (${this.turns.fixtureCode})` : ""}, ${this.turns.processes.length} process(es), ${replyIndex} repl${replyIndex === 1 ? "y" : "ies"}`,
      );
    } finally {
      clearInterval(stats);
      await firstSample;
      await tail.close();
      await openClaimGate();
      if (claimer) this.claim = await claimer.settle();
      d1Stopped = true;
      if (d1Claim) this.claim = (await d1Claim) ?? this.claim;
      this.extraPhases.push({
        name: "harness",
        startedAt: iso(harnessStartedMs),
        durationS: Math.round((this.deps.now() - harnessStartedMs) / 1000),
      });
    }
    log(
      `claim: ${this.claim.how}${this.claim.latencyS !== null ? `, ${this.claim.latencyS} s after the link` : ""}${this.claim.harnessSelfClaimed ? ", harness self-claimed" : ""}`,
    );

    // A kill ended the harness's exec (its container is gone): no collect, no verifier.
    this.stopIfKilled();

    // 8. Collect, redact, diff; expire any link still open (cleanup() does it again on every exit path).
    await this.collect();
    await this.expireLinks();

    // 9. The outside-in verifier.
    this.stopIfKilled();
    await this.verifyFromOutside(fetchImpl);
  }

  /** No unconsumed owner link outlives the run (design 4.2 step 9); safe to call more than once. */
  private async expireLinks(): Promise<void> {
    await expireUnconsumedLinks(this.d1).catch((error: unknown) =>
      this.log(`expiring unconsumed links failed: ${(error as Error).message}`),
    );
  }

  /**
   * While a reply is held for a `setup` the event log saw start but not
   * end: is its process still there? Claude Code kills its background tasks
   * when the `-p` process ends and Codex kills its terminals at 5 minutes;
   * Node writes no `exit` line on SIGKILL, so the feed would wait 15
   * minutes for a process that is gone.
   */
  private async checkSetupAlive(): Promise<void> {
    if (!this.sandbox || !this.handle) return;
    for (const pid of this.feed.inFlightSetupPids()) {
      let alive = true;
      try {
        const probe = await this.exec([
          "bash",
          "-c",
          `kill -0 ${pid} 2>/dev/null`,
        ]);
        alive = probe.exitCode === 0;
      } catch {
        // The container itself is gone: nothing more to wait for either.
        alive = false;
      }
      if (alive) continue;
      const at = iso(this.deps.now());
      this.backgroundKills.push({ at, pid });
      this.feed.markSetupKilled(pid);
      this.log(
        `setup (pid ${pid}) is gone with no exit line: killed by the harness; the held reply goes out now`,
      );
    }
  }

  private async exec(
    argv: string[],
    cwd?: string,
  ): Promise<{ exitCode: number | null; lines: string[] }> {
    const lines: string[] = [];
    const result = await this.sandbox!.exec(this.handle!, argv, {
      ...(cwd ? { cwd } : {}),
      timeoutMs: 10 * 60_000,
      onLine: (line) => lines.push(line.line),
    });
    return { exitCode: result.exitCode, lines };
  }

  /** CI, TERM and SHELL as the running everyapp saw them, once, from /proc/<pid>/environ. */
  private async readToolEnv(pid: number): Promise<void> {
    if (this.toolEnv || !this.sandbox || !this.handle) return;
    try {
      const out = await this.exec([
        "bash",
        "-c",
        `tr '\\0' '\\n' < /proc/${pid}/environ | grep -E '^(CI|TERM|SHELL)=' || true`,
      ]);
      const env = new Map(
        out.lines.flatMap((line) => {
          const match = /^(CI|TERM|SHELL)=(.*)$/.exec(line);
          return match ? [[match[1]!, match[2]!] as const] : [];
        }),
      );
      this.toolEnv = {
        CI: env.get("CI") ?? null,
        TERM: env.get("TERM") ?? null,
        SHELL: env.get("SHELL") ?? null,
      };
    } catch {
      // The process ended before it could be read: the record keeps nulls.
    }
  }

  /** `pnpm loop answer <runId> "<text>"` drops a file here; one is consumed per turn end. */
  private takePersonAnswer(): string | null {
    const dir = path.join(this.ctx.runDir, "answers");
    if (!fs.existsSync(dir)) return null;
    const file = fs.readdirSync(dir).sort()[0];
    if (!file) return null;
    const text = fs.readFileSync(path.join(dir, file), "utf8").trim();
    fs.rmSync(path.join(dir, file), { force: true });
    return text || null;
  }

  /**
   * The wipe in a sibling. Before the run, whatever fails in it (the marker
   * refused, the sibling's clone or install, the token gate, the CLI, what
   * is left) ends the run as `teardown_failed` with an infra error at step
   * `teardown.before`: nothing was installed and the verifier never ran, so
   * the decision table reads it as fail-infra, never as the agent's red
   * verifier. After the run, cleanup() catches and records instead.
   */
  private async teardown(
    label: "before" | "after",
    file: string,
  ): Promise<TeardownStepResult> {
    const { account, cf, log } = this.ctx;
    const started = this.deps.now();
    let result: TeardownStepResult;
    try {
      await this.ensureBundle(this.toolsBundle, this.options.toolsRef, "wipe");
      result = await withTestAccount(
        {
          sandbox: this.ctx.docker!.sandbox,
          image: this.ctx.image,
          account,
          runId: this.ctx.runId,
          allowlist: true,
          bundlePath: this.toolsBundle,
          cf,
          onLine: (line) => this.siblingLine("teardown", line),
          ...this.trackSibling(),
          // The post-run wipe is cleanup itself: a signal during it must not cut it short.
          ...(label === "before" ? { signal: this.stopped.signal } : {}),
        },
        (sibling) =>
          runTeardownStep({
            sibling,
            account,
            runId: this.ctx.runId,
            cf,
            now: this.deps.now,
            sleep: this.deps.sleep,
            confirm: () => this.confirm(),
            // A marker whose run's lock died here is a dead driver's, stale whatever its age; one
            // with no lock here may be another machine's run, refused while young; this run's own
            // marker is never another run's, so the post-run wipe removes it.
            locks: knownLocks(locksDir(this.deps.configDir), this.deps.now()),
          }),
      );
    } catch (error) {
      // A kill interrupted the wipe (cleanup removed its sibling): the kill is the reason, not this.
      if (label === "after" || error instanceof RunAbort || this.killedBy)
        throw error;
      const code =
        error instanceof TeardownStepError
          ? error.code
          : error instanceof SiblingError
            ? "sibling_failed"
            : error instanceof TokenGateError
              ? "token_gate"
              : "error";
      const message =
        error instanceof TokenGateError
          ? `${error.message} (${error.gate.code})`
          : `${(error as Error).message ?? error}`;
      log(`wipe before the run ${code}: ${message}`);
      throw new RunAbort("teardown_failed", {
        code: `teardown_${code}`,
        step: "teardown.before",
        source: "infra",
        message: message.slice(0, 500),
      });
    }
    writePrivate(
      this.ctx.runDir,
      file,
      `${JSON.stringify({ before: result.before, after: result.after, removed: result.removed, kept: result.kept, dnsLeftovers: result.dnsLeftovers, skipped: result.skipped }, null, 2)}\n`,
    );
    if (affectsDns(result.removed))
      recordTeardown(
        locksDir(this.deps.configDir),
        account.accountId,
        iso(this.deps.now()),
      );
    this.extraPhases.push({
      name: `teardown.${label}`,
      startedAt: iso(started),
      durationS: Math.round((this.deps.now() - started) / 1000),
    });
    log(
      `teardown ${label}: removed ${result.removed.length}, kept ${result.kept.length}, ${result.polls} poll(s)`,
    );
    return result;
  }

  /**
   * A file for the container to copy in, in the driver's temp dir. The dir
   * is made again first: the live run of 2026-10-24 found it gone mid-run
   * (by what is not known; noteTempDir() logs when), and a reply that
   * cannot be written would end the harness's turns for that.
   */
  private tempFile(name: string, text: string): string {
    fs.mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
    return writePrivate(this.tempDir, name, text);
  }

  /**
   * Whether the temp dir is still there, in the log at the moments that
   * matter (verify start, before the post-run wipe), so the next live run
   * pins when the 2026-10-24 deletion happened. Nothing in this process
   * removes it before cleanup()'s last line.
   */
  private noteTempDir(when: string): void {
    const present = fs.existsSync(this.tempDir);
    this.log(
      `temp dir ${present ? "present" : "GONE"} ${when} (${this.tempDir}${present ? "" : "; removed by something outside this driver"})`,
    );
  }

  /**
   * The bundles every sibling clones (the tools bundle for a wipe, the test
   * bundle for the verifier) live in the driver's temp dir, which cleanup()
   * removes last of all, after the post-run wipe. Should one be gone anyway
   * when a sibling needs it (the live run of 2026-10-24 found the temp dir
   * so and kept the Gateway), the bundle is made again from the checkout
   * rather than the sibling skipped.
   */
  private async ensureBundle(
    file: string | null,
    ref: string,
    what: "wipe" | "verifier",
  ): Promise<void> {
    if (!file || fs.existsSync(file)) return;
    this.log(
      `the bundle ${file} is gone before the ${what}: making it again from ${ref}`,
    );
    fs.mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
    await createBundle(this.deps.spawn, this.deps.repoRoot, ref, file);
  }

  /** The hooks that keep `siblings` current, so cleanup() can remove one a signal interrupted. */
  private trackSibling(): {
    onCreated: (handle: SandboxHandle) => void;
    onDestroyed: (handle: SandboxHandle) => void;
  } {
    return {
      onCreated: (handle) => this.siblings.set(handle.name, handle),
      onDestroyed: (handle) => this.siblings.delete(handle.name),
    };
  }

  private confirm(): Promise<string> {
    if (this.deps.confirm) return this.deps.confirm(this.ctx.account);
    const file = confirmPath(this.deps.configDir, this.ctx.account.accountId);
    const fromFile = readConfirmFile(file, this.ctx.account.accountId);
    if (fromFile) {
      this.log(`teardown confirmation from ${file}`);
      return Promise.resolve(fromFile);
    }
    return confirmFromTty(this.ctx.account.accountId);
  }

  private siblingLine(what: string, line: ExecLine): void {
    fs.appendFileSync(
      path.join(this.ctx.runDir, `${what}.sibling.redacted.log`),
      `${this.ctx.redactor.redact(`${line.stream} ${line.line}`)}\n`,
    );
  }

  private async collect(): Promise<void> {
    const { log, redactor, runDir } = this.ctx;
    const sandbox = this.sandbox;
    const handle = this.handle;
    if (!sandbox || !handle) return;
    try {
      const diff = await sandbox.diff(handle);
      writePrivate(
        runDir,
        RUN_FILES.diff,
        diff.map((e) => `${e.kind[0]!.toUpperCase()} ${e.path}`).join("\n") +
          "\n",
      );
      this.diffEntries = diff;
    } catch (error) {
      log(`docker diff failed: ${(error as Error).message}`);
    }
    // Tampering, precisely: tracked files changed or files added under the roots that git does not
    // ignore. Build output never shows here, where `docker diff` lists every build directory.
    try {
      const status = await this.exec(
        [
          "git",
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          "apps/every-app-gateway",
          "packages",
          "templates",
          "starter",
        ],
        CHECKOUT_PATH,
      );
      if (status.exitCode === 0) {
        this.gitStatus = status.lines.filter((line) => line.trim() !== "");
        writePrivate(
          runDir,
          RUN_FILES.gitStatus,
          `${this.gitStatus.join("\n")}\n`,
        );
      } else log(`git status in the checkout exited ${status.exitCode}`);
    } catch (error) {
      log(`git status in the checkout failed: ${(error as Error).message}`);
    }
    const collected = path.join(runDir, "collected");
    fs.mkdirSync(collected, { recursive: true, mode: 0o700 });
    const targets = [
      { inside: LOOP_DIR, name: "loop" },
      ...this.ctx.adapter.collectPaths.map((p) => ({
        inside: `/home/dev/${p}`,
        name: `home/${p}`,
      })),
    ];
    for (const target of targets) {
      const host = path.join(collected, target.name);
      fs.mkdirSync(path.dirname(host), { recursive: true, mode: 0o700 });
      try {
        await sandbox.copyOut(handle, target.inside, host);
      } catch {
        // A session store the harness never wrote: nothing to collect.
      }
    }
    const copiedLog = path.join(
      collected,
      "loop",
      path.basename(EVENT_LOG_PATH),
    );
    const adopt = this.readCopiedEventLog(copiedLog);
    const files = redactTree(collected, redactor, log);
    log(`collected ${files} file(s) into ${collected}, redacted`);
    // Now redacted like the tailed file was, line by line as it arrived: the copy replaces it.
    if (adopt) {
      writePrivate(
        runDir,
        RUN_FILES.eventLog,
        fs.readFileSync(copiedLog, "utf8"),
      );
      this.completeEventLog = adopt;
    }
  }

  /**
   * The tail can miss the CLI's last lines (its `error` and `exit`, written
   * in the second before the process ended and the harness's exec
   * returned); the copy `docker cp` took out of the container is complete.
   * Parsed raw, like the feed's lines, when it exists and is at least as
   * long as what the tail delivered; null keeps the tail's.
   */
  private readCopiedEventLog(file: string): EventLogLine[] | null {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    const copied = text.split("\n").filter((line) => line.trim() !== "").length;
    const tailed = this.feed.raw.length;
    if (copied < tailed) {
      this.log(
        `event log: the copy from the container has ${copied} line(s), the tail delivered ${tailed}; keeping the tail's`,
      );
      return null;
    }
    if (copied > tailed)
      this.log(
        `event log: the tail delivered ${tailed} of ${copied} line(s); the copy from the container replaces it`,
      );
    return parseEventLog(text);
  }

  /** The event log the record is assembled from: the complete copy when collect() got one, else the tail's lines. */
  private eventLogLines(): EventLogLine[] {
    return this.completeEventLog ?? this.feed.lines;
  }

  /** A `*.apps.<zone>` record exists (then G3's unknown-host probe reaches the gateway); false when none or unreadable. */
  private async wildcardAppsRecord(): Promise<boolean> {
    const zoneId = this.ctx.preflight.fixtures.zoneId;
    if (!zoneId) return false;
    try {
      const records = await this.ctx.cf.dnsRecordsList(zoneId);
      const wildcard = `*.apps.${this.ctx.account.zone}`.toLowerCase();
      return records.some(
        (record) =>
          record.name.toLowerCase() === wildcard &&
          ["A", "AAAA", "CNAME"].includes(record.type.toUpperCase()),
      );
    } catch (error) {
      this.log(`dns records unreadable: ${(error as Error).message}`);
      return false;
    }
  }

  private async verifyFromOutside(fetchImpl: FetchLike): Promise<void> {
    const { account, cf, log } = this.ctx;
    const started = this.deps.now();
    const traces = everyappCommandsFrom(this.eventLogLines());
    const app = appFrom(traces);
    const events: NormalizedEvent[] = this.turns?.processes.flat() ?? [];
    // The event log says the harness deployed; without the seam, its own tool calls do (an
    // `everyapp deploy` whose next tool result is not an error). The verifier confirms with status.
    const harnessDeployed = app.deployed || deployedByToolCalls(events);
    const appHost = app.url ? new URL(app.url).hostname : null;
    const team = this.options.withAccess ? subdomainFor(account.name) : null;
    const wildcard = await this.wildcardAppsRecord();
    // The log speaks about an upload only once a setup or update ran under the seam. None (the npx
    // trap: a published pre-seam CLI; or everyapp run with the env stripped): the full windows.
    const logSpeaks =
      this.eventLogSeam &&
      traces.some((t) => t.argv[0] === "setup" || t.argv[0] === "update");
    this.noteTempDir("at verify start");
    try {
      await this.ensureBundle(this.testBundle, this.options.ref, "verifier");
      this.verifyResult = await withTestAccount(
        {
          sandbox: this.ctx.docker!.sandbox,
          image: this.ctx.image,
          account,
          runId: this.ctx.runId,
          bundlePath: this.testBundle,
          cf,
          onLine: (line) => this.siblingLine("verify", line),
          ...this.trackSibling(),
          signal: this.stopped.signal,
        },
        (sibling: Sibling) =>
          verify(
            {
              zone: account.zone,
              gatewayOrigin: this.gatewayOrigin,
              appHost,
              owner: this.owner,
              claimHow: this.claim.how,
              diff: this.diffEntries,
              events,
              harnessDeployedApp: harnessDeployed,
              withAccess: this.options.withAccess,
              team,
              templateMarker: TEMPLATE_MARKER,
              wildcardAppsRecord: wildcard,
              gitStatus: this.gitStatus,
              ...(logSpeaks
                ? { gatewayUploaded: gatewayUploadedFrom(traces) }
                : {}),
            },
            {
              fetchImpl,
              runStatus: async () => {
                const out = await sibling.everyapp(["status", "--json"], {
                  timeoutMs: 5 * 60_000,
                });
                const parsed = parseEvents(out.stdout);
                const done = parsed.find((e) => e.type === "done");
                return {
                  exitCode: out.result.exitCode,
                  data:
                    done && done.type === "done" ? (done.data ?? null) : null,
                  events: parsed,
                };
              },
              deployProbe: async () => {
                log(
                  "the harness deployed no app: the verifier's own create + deploy runs as a product probe",
                );
                const create = await sibling.everyapp(
                  ["create", "hello", "--json"],
                  { timeoutMs: 10 * 60_000 },
                );
                if (create.result.exitCode !== 0) return null;
                const deploy = await sibling.exec(
                  ["pnpm", "everyapp", "deploy", "--json"],
                  {
                    cwd: `${CHECKOUT_PATH}/apps/hello`,
                    timeoutMs: 15 * 60_000,
                  },
                );
                const done = parseEvents(deploy.stdout).find(
                  (e) => e.type === "done",
                );
                const url =
                  done &&
                  done.type === "done" &&
                  typeof done.data?.["url"] === "string"
                    ? done.data["url"]
                    : null;
                return url
                  ? { id: "hello", host: new URL(url).hostname }
                  : null;
              },
              accessOff: async () => {
                await sibling.everyapp(["access", "off", "--yes", "--json"], {
                  timeoutMs: 5 * 60_000,
                });
              },
              sleep: this.deps.sleep,
              now: () => new Date(this.deps.now()),
            },
          ),
      );
      writeVerifyEvidence(
        this.ctx.runDir,
        this.verifyResult,
        this.ctx.redactor.redact,
      );
      const rows = Object.values(this.verifyResult.rows)
        .map((r) => `${r.id}=${r.status}`)
        .join(" ");
      log(`verify: ${rows}; phase ${this.verifyResult.phaseReached}`);
    } catch (error) {
      this.verifierInconclusive = true;
      this.errors.push({
        code: "verifier_inconclusive",
        step: "verify",
        source: "infra",
        message: `${(error as Error).message}`.slice(0, 300),
      });
      log(`verifier inconclusive: ${(error as Error).message}`);
    }
    this.extraPhases.push({
      name: "verify",
      startedAt: iso(started),
      durationS: Math.round((this.deps.now() - started) / 1000),
    });
  }

  /**
   * The container gone, every sibling a signal interrupted gone, the run's
   * marker gone, every open link expired, the wipe again, then a second
   * look for any container that appeared meanwhile: in a finally and on a
   * signal, once, whatever happened. Every caller awaits the same pass, so
   * neither path exits while the other's cleanup is half done.
   */
  cleanup(): Promise<void> {
    this.cleanupPromise ??= this.cleanupOnce();
    return this.cleanupPromise;
  }

  /** `docker rm -f` of the harness's container, once; --keep leaves it. */
  private async removeContainer(): Promise<void> {
    const { log } = this.ctx;
    if (!this.handle || !this.sandbox || this.containerRemoved) return;
    this.containerRemoved = true;
    if (this.options.keep) {
      log(
        `--keep: container ${this.handle.name} left running (docker exec -it ${this.handle.name} bash; docker rm -f it when done)`,
      );
      return;
    }
    await this.sandbox
      .destroy(this.handle)
      .catch((error: unknown) =>
        log(`docker rm failed: ${(error as Error).message}`),
      );
  }

  /**
   * A wipe or the verifier a signal cut short: its container goes now
   * (withTestAccount's own finally would, but only once its exec returns,
   * and the exec is what the kill interrupted).
   */
  private async removeSiblings(): Promise<void> {
    const { log } = this.ctx;
    for (const [name, handle] of [...this.siblings]) {
      log(
        `removing sibling ${name} the ${this.killedBy ?? "cleanup"} interrupted`,
      );
      await this.ctx
        .docker!.sandbox.destroy(handle)
        .catch((error: unknown) =>
          log(`docker rm ${name} failed: ${(error as Error).message}`),
        );
      this.siblings.delete(name);
    }
  }

  private async cleanupOnce(): Promise<void> {
    const { log } = this.ctx;
    await this.removeContainer();
    await this.removeSiblings();
    // This run's marker: its own runId is never "another run's", so the wipe below would remove
    // it too; removing it here first costs one call and holds when the wipe cannot run.
    if (this.markerCreated) {
      await removeRunMarker(this.ctx.cf, this.ctx.runId).then(
        (removed) => {
          if (removed) log("run marker removed");
        },
        (error: unknown) =>
          log(`run marker not removed: ${(error as Error).message}`),
      );
    }
    // Anything after the seed was written may have created resources: expire any link `setup`
    // minted, then wipe again.
    if (this.toolsBundle && this.seed && (this.markerCreated || this.handle)) {
      await this.expireLinks();
      this.noteTempDir("before the post-run wipe");
      try {
        const after = await this.teardown("after", RUN_FILES.inventoryAfter);
        if (after.after.total > 0)
          log(`post-run footprint: ${after.after.total} resource(s) left`);
      } catch (error) {
        this.errors.push({
          code: "teardown_after_failed",
          step: "teardown",
          source: "infra",
          message: `${(error as Error).message}`.slice(0, 300),
        });
        log(`teardown after the run failed: ${(error as Error).message}`);
      }
    }
    // A create that was in flight when the first pass looked (the harness's container, a sibling)
    // has returned by now: nothing outlives the driver.
    await this.removeContainer();
    await this.removeSiblings();
    if (this.caffeinatePid) {
      try {
        process.kill(this.caffeinatePid);
      } catch {
        // Already gone.
      }
    }
    // Last of all: the post-run wipe's sibling copied the tools bundle out of here.
    fs.rmSync(this.tempDir, { recursive: true, force: true });
  }

  /** run.json, rotate.json when a secret was echoed, the summary; once, whichever path gets here first. */
  finish(): RunRecord {
    if (this.finished) return this.finished;
    const { log, runDir, redactor } = this.ctx;
    const finishedMs = this.deps.now();
    const seed =
      this.seed ??
      emptyRunRecord({
        runId: this.ctx.runId,
        startedAt: iso(this.ctx.startedMs),
        accountName: this.ctx.account.name,
        harness: {
          name: this.ctx.adapter.name,
          version: this.ctx.adapter.version,
          model: { requested: this.ctx.model, resolved: null },
          mode: this.ctx.adapter.name === "claude" ? this.options.mode : null,
          commandLine: "",
          permissionBypass: true,
        },
        signal: this.ctx.adapter.signal,
        checkout: { commit: "", ref: this.options.ref, how: "bundle" },
        cli: { commit: "", version: "" },
        prompt: { variant: this.options.promptVariant, sha256: "" },
        substrate: {
          kind: "docker",
          engine: this.ctx.preflight.docker?.engine ?? "",
          image: { tag: this.ctx.image, platform: "linux/arm64" },
          vmMemoryGiB: null,
          statsPeakMiB: null,
        },
      });
    seed.deviations = this.deviations;
    seed.retryOf = this.options.retryOf;
    const saved: SavedAssembleInput = {
      startedAt: iso(this.ctx.startedMs),
      finishedAt: iso(finishedMs),
      exits: this.turns?.exits ?? [],
      resumes: this.turns?.resumes ?? [],
      turns: this.turns
        ? { terminal: this.turns.terminal, fixtureCode: this.turns.fixtureCode }
        : null,
      user: this.user.state,
      claim: this.claim,
      preflight: {
        ok: this.ctx.preflight.ok,
        reasonCode: this.ctx.preflight.reasonCode,
      },
      preRunPlanTotal: this.preRunPlanTotal,
      driverErrors: this.errors,
      exposure: redactor.exposure(),
      statsPeakMiB: this.statsPeakMiB,
      memoryLimitMiB: CONTAINER_MEMORY_MIB,
      withAccess: this.options.withAccess,
      team: this.options.withAccess
        ? subdomainFor(this.ctx.account.name)
        : null,
      gatewayOrigin: this.gatewayOrigin,
      verifierInconclusive: this.verifierInconclusive,
      dnsNegativeCache: this.dnsNegativeCache,
      extraPhases: this.extraPhases,
      toolEnv: this.toolEnv,
      driverFailure: this.terminal,
      backgroundKills: this.backgroundKills,
    };
    // The in-memory events and event log are raw (only their copies on disk were redacted as they
    // arrived): everything assembled from them goes through the redactor before it is written or returned.
    const assembled = assemble({
      ...saved,
      seed,
      eventLog: this.eventLogLines(),
      processes: this.turns?.processes ?? [],
      verify: this.verifyResult,
    });
    const record = redactJson(redactor, assembled.record);
    const decision = redactJson(redactor, assembled.decision);
    // What `loop reparse` and `loop replay` need beside the artifacts: the gateway origin inside is the zone, so mode 600 like the rest.
    writePrivate(
      runDir,
      RUN_FILES.assembleInput,
      `${JSON.stringify(redactJson(redactor, saved), null, 2)}\n`,
    );
    writePrivate(
      runDir,
      RUN_FILES.decideInput,
      `${JSON.stringify(decision, null, 2)}\n`,
    );
    const exposure = redactor.exposure();
    if (exposure.cf_token > 0 || exposure.provider_key > 0) {
      const values: RotateFile["values"] = [];
      if (exposure.cf_token > 0)
        values.push({
          name: "cf_token",
          sha256: sha256(this.ctx.account.token),
        });
      if (exposure.provider_key > 0 && this.ctx.provider)
        values.push({
          name: "provider_key",
          sha256: sha256(this.ctx.provider.value),
        });
      writePrivate(
        runDir,
        RUN_FILES.rotate,
        `${JSON.stringify({ values }, null, 2)}\n`,
      );
      for (const value of values)
        log(
          `ROTATE: ${value.name === "cf_token" ? `the Cloudflare token of ${this.ctx.account.name}` : this.ctx.provider?.name} was echoed in this run; roll it (runbook section 8) and the loop refuses it until then`,
        );
    }
    if (exposed(exposure))
      log(`secret exposure counters: ${JSON.stringify(exposure)}`);
    const file = writeRunRecord(this.deps.runsRoot, record);
    log(
      `${record.verdict.value}${record.verdict.reasonCode ? ` (${record.verdict.reasonCode})` : ""}: phase ${record.verify.phaseReached}, ${record.durationS} s, ${record.everyappCommands.length} everyapp command(s), ${record.interventions.length} intervention(s), cost ${record.cost.usd === null ? "n/a" : `$${record.cost.usd.toFixed(2)}`}; record ${file}`,
    );
    this.finished = record;
    return record;
  }

  private keepAwake(): void {
    if (!this.deps.caffeinate) return;
    try {
      // `caffeinate -w <pid>` ends when this process does; nothing to clean up on a crash.
      const child = nodeSpawn("caffeinate", ["-i", "-w", String(process.pid)], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => undefined);
      child.unref();
      this.caffeinatePid = child.pid ?? null;
    } catch {
      // No caffeinate (not macOS): the run goes on.
    }
  }
}
