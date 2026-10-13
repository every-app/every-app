/**
 * The one place the CLI runs `cf`.
 *
 * Every call goes through {@link CfRunner} so the spawn contract holds
 * everywhere:
 *  - a pinned `cf` run with this Node (never a global `cf`), and this Node
 *    first on its PATH for what cf starts (`pnpm vite …`);
 *  - piped calls get their own process group and no stdin, so a hung `cf` and
 *    everything it started can be killed together;
 *  - account-plane calls run in an empty private directory, because cf
 *    runs a `cloudflare.config.ts` it finds in the working directory or any
 *    parent: a broken one would break every API command, and one planted in
 *    the shared temp directory would run with the deploy's credentials (see
 *    ./privateDir.ts, which also holds the files cf is handed);
 *  - CLOUDFLARE_ACCOUNT_ID is passed whenever the account is known;
 *  - `--local` calls get a watchdog: cf sometimes prints its full JSON result
 *    and then never exits (a handle Miniflare leaves open), so once stdout
 *    parses and the process has been quiet for a moment, the group is killed
 *    and the result kept;
 *  - on Ctrl+C or SIGTERM, running cf calls are stopped and their private
 *    files removed before everyapp exits (../interrupt.ts).
 *
 * Commands take a {@link CfRunner} so tests can swap in `FakeCf`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { onInterrupt, trackChild } from "@/lib/interrupt";
import type { z } from "zod";
import { resolveCfBinary, type CfBinary } from "./bin";
import {
  abortedCfError,
  CfError,
  CfOutputError,
  CfTimeoutError,
  parseCfStderr,
} from "./errors";
import {
  CF_FILES_PREFIX,
  cfNeutralDir,
  makeCfTempDir,
  thisNodeBinDir,
} from "./privateDir";
import { assertToolchainNode, runsPackageManager } from "./toolchain";

type CfOutputMode = "json" | "text" | "interactive";
type CfPlane = "account" | "project";

export interface CfCall {
  /** cf arguments. A function receives the paths of `files` once written. */
  args: readonly string[] | ((files: Record<string, string>) => string[]);
  /** "account" runs in a neutral directory; "project" in `cwd`. */
  plane: CfPlane;
  /** App root for project-plane calls. */
  cwd?: string;
  /**
   * Run the CLI's own pinned cf even for a project-plane call: the tree is
   * not an app (a gateway release), so no `node_modules/cf` above it counts.
   */
  cliCf?: boolean;
  /**
   * "json"/"text" pipe stdout and stderr; "interactive" inherits the terminal
   * (only for commands a human answers, like `cf auth login`).
   */
  mode: CfOutputMode;
  /** Arm the watchdog for `--local` commands. */
  local?: boolean;
  /** Hard limit; defaults to 2 minutes for piped calls and none for interactive ones. */
  timeoutMs?: number;
  /** Written to a private temp directory (files 0600) and removed afterwards. */
  files?: Record<string, string | object>;
  env?: Record<string, string | undefined>;
  /** Sees stdout and stderr as they arrive (piped modes), e.g. a login's code. */
  onOutput?: (chunk: string) => void;
}

export interface CfResult {
  stdout: string;
  stderr: string;
  /** The watchdog ended a `--local` command that had printed its result but not exited. */
  stoppedByWatchdog: boolean;
}

/** A long-running cf process (`cf dev`) in its own process group. */
export interface CfProcess {
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  /** Signal the whole process group (cf, the package manager, Vite, workerd). */
  stop(signal?: NodeJS.Signals): void;
}

export interface CfStartCall {
  args: readonly string[];
  /** App root. */
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface CfRunner {
  run(call: CfCall): Promise<CfResult>;
  start(call: CfStartCall): Promise<CfProcess>;
}

export interface CfRunnerOptions {
  /** Passed to every call as CLOUDFLARE_ACCOUNT_ID. */
  accountId?: string;
  /** Overrides how `cf` is found (tests point it at a fake script). */
  resolveBinary?: (projectRoot?: string) => Promise<CfBinary>;
  /** Quiet period after a complete JSON result before a `--local` call is stopped. */
  watchdogIdleMs?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WATCHDOG_IDLE_MS = 2_000;
const KILL_GRACE_MS = 1_000;
// Windows has no process groups to signal; children are stopped one by one.
const PROCESS_GROUPS = process.platform !== "win32";

export function createCfRunner(options: CfRunnerOptions = {}): CfRunner {
  const resolveBinary = options.resolveBinary ?? resolveCfBinary;
  const baseEnv = options.env ?? process.env;
  const idleMs = options.watchdogIdleMs ?? DEFAULT_WATCHDOG_IDLE_MS;

  let nodeBinDir: Promise<string> | undefined;
  async function childEnv(
    mode: CfOutputMode,
    extra: Record<string, string | undefined> = {},
  ): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...(mode === "interactive" ? {} : { NO_COLOR: "1" }),
      ...(mode === "json" ? { CF_QUIET: "1" } : {}),
      ...(options.accountId
        ? { CLOUDFLARE_ACCOUNT_ID: options.accountId }
        : {}),
      ...extra,
    };
    nodeBinDir ??= thisNodeBinDir();
    return withFirstOnPath(env, await nodeBinDir);
  }

  return {
    async run(call) {
      const cwd = await workingDirectory(call);
      const binary = await resolveBinary(
        call.plane === "project" && !call.cliCf ? cwd : undefined,
      );
      const files = call.files ? await writePrivateFiles(call.files) : null;
      try {
        const args =
          typeof call.args === "function"
            ? call.args(files?.paths ?? {})
            : [...call.args];
        const env = await childEnv(call.mode, call.env);
        if (call.plane === "project" && runsPackageManager(args)) {
          await assertToolchainNode(cwd, env);
        }
        return await spawnCf({
          binary,
          args,
          cwd,
          env,
          onOutput: call.onOutput,
          mode: call.mode,
          timeoutMs:
            call.timeoutMs ??
            (call.mode === "interactive" ? undefined : DEFAULT_TIMEOUT_MS),
          watchdogIdleMs: call.local ? idleMs : undefined,
        });
      } finally {
        if (files) {
          await fs.rm(files.dir, { recursive: true, force: true });
          files.forget();
        }
      }
    },

    async start(call) {
      const binary = await resolveBinary(call.cwd);
      const env = await childEnv("interactive", call.env);
      if (runsPackageManager(call.args)) {
        await assertToolchainNode(call.cwd, env);
      }
      const child = spawn(process.execPath, [binary.path, ...call.args], {
        cwd: call.cwd,
        // Output goes straight to the terminal, so it keeps its colors.
        env,
        // No stdin: a detached group reading the terminal would be stopped
        // with SIGTTIN.
        stdio: ["ignore", "inherit", "inherit"],
        detached: PROCESS_GROUPS,
      });
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      return {
        exited,
        stop: (signal) => stopChild(child, PROCESS_GROUPS, signal),
      };
    },
  };
}

/** Run a json-mode call and validate its stdout with `schema`. */
export async function runCfJson<T>(
  cf: CfRunner,
  call: Omit<CfCall, "mode">,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await cf.run({ ...call, mode: "json" });
  const command = describe(call.args);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CfOutputError(command, "stdout is not JSON");
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new CfOutputError(command, validated.error.message);
  }
  return validated.data;
}

async function workingDirectory(call: CfCall): Promise<string> {
  if (call.plane === "project") {
    if (!call.cwd) throw new Error("project-plane cf calls need a cwd");
    return call.cwd;
  }
  return cfNeutralDir();
}

/**
 * Write `files` to a new private directory, which goes even when everyapp
 * is interrupted: call `forget` once it's removed.
 */
async function writePrivateFiles(files: Record<string, string | object>): Promise<{
  dir: string;
  paths: Record<string, string>;
  forget: () => void;
}> {
  const dir = await makeCfTempDir(CF_FILES_PREFIX);
  const forget = onInterrupt({
    sync: () => rmSync(dir, { recursive: true, force: true }),
  });
  const paths: Record<string, string> = {};
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, path.basename(name));
      await fs.writeFile(
        file,
        typeof content === "string" ? content : JSON.stringify(content),
        { mode: 0o600 },
      );
      paths[name] = file;
    }
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    forget();
    throw error;
  }
  return { dir, paths, forget };
}

interface SpawnCfOptions {
  binary: CfBinary;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
  mode: CfOutputMode;
  timeoutMs?: number;
  watchdogIdleMs?: number;
}

function spawnCf(options: SpawnCfOptions): Promise<CfResult> {
  const command = describe(options.args);
  const interactive = options.mode === "interactive";

  return new Promise<CfResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [options.binary.path, ...options.args],
      {
        cwd: options.cwd,
        env: options.env,
        // Interactive commands keep our process group so they can read the
        // terminal; piped ones get their own so the watchdog can kill them all.
        stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
        detached: !interactive && PROCESS_GROUPS,
      },
    );
    const untrack = trackChild(child, !interactive && PROCESS_GROUPS);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      untrack();
      clearTimeout(deadline);
      clearTimeout(idleTimer);
      outcome();
    };

    const timeoutMs = options.timeoutMs;
    const deadline =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stopChild(child, !interactive && PROCESS_GROUPS);
            finish(() =>
              reject(new CfTimeoutError(command, timeoutMs, lastLine(stderr))),
            );
          }, timeoutMs);

    // After a complete JSON document, any further output restarts the quiet
    // period; silence for the whole period means cf is done but stuck.
    const watch = () => {
      if (options.watchdogIdleMs === undefined || settled) return;
      if (!idleTimer && !isCompleteJson(stdout)) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stopChild(child, PROCESS_GROUPS);
        finish(() => resolve({ stdout, stderr, stoppedByWatchdog: true }));
      }, options.watchdogIdleMs);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      options.onOutput?.(chunk.toString());
      watch();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      options.onOutput?.(chunk.toString());
      watch();
    });

    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        if (code === 0) {
          const aborted = abortedCfError(command, stderr);
          if (aborted) reject(aborted);
          else resolve({ stdout, stderr, stoppedByWatchdog: false });
          return;
        }
        const parsed = interactive
          ? {
              message: `\`${command}\` exited with code ${code}`,
              apiCodes: [],
              kind: "unknown" as const,
            }
          : parseCfStderr(stderr);
        reject(new CfError(parsed, { exitCode: code, stderr }));
      });
    });
  });
}

/**
 * Signal a child, or its whole process group when it leads one, and escalate
 * to SIGKILL if it outlives the grace period.
 */
function stopChild(
  child: ChildProcess,
  group: boolean,
  signal: NodeJS.Signals = "SIGTERM",
) {
  const pid = child.pid;
  if (pid === undefined) return;
  const send = (sig: NodeJS.Signals) => {
    try {
      if (group) process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  send(signal);
  if (signal !== "SIGKILL") {
    setTimeout(() => send("SIGKILL"), KILL_GRACE_MS).unref();
  }
}

/** `env` with `dir` first on its PATH (whatever its case on Windows). */
function withFirstOnPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const rest = (env[key] ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && entry !== dir);
  return { ...env, [key]: [dir, ...rest].join(path.delimiter) };
}

function isCompleteJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function lastLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function describe(args: CfCall["args"]): string {
  return typeof args === "function" ? "cf" : ["cf", ...args].join(" ");
}
