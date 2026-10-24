/**
 * The one place the CLI runs `cf`.
 *
 * Every call goes through {@link CfRunner} so the spawn contract holds
 * everywhere:
 *  - a pinned `cf` run with this Node (never a global `cf`), and this Node
 *    first on its PATH for what cf starts (`pnpm vite …`);
 *  - project-plane calls (`cf build`, `cf deploy`, `cf dev`) run with the
 *    build's NODE_OPTIONS (../runtime.ts `buildNodeOptions`), so a
 *    TanStack Start prerender finds its preview server on Linux;
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
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { trackChild } from "@/lib/interrupt";
import {
  PROCESS_GROUPS,
  spawnLongRunning,
  stopChild,
  type LongRunningProcess,
} from "@/lib/longRunning";
import { handTerminalOver } from "@/lib/output/terminal";
import { outputTail } from "@/lib/output/text";
import { buildNodeOptions } from "@/lib/runtime";
import type { z } from "zod";
import { resolveCfBinary, type CfBinary } from "./bin";
import {
  abortedCfError,
  CfError,
  CfOutputError,
  CfTimeoutError,
  parseCfOutput,
} from "./errors";
import {
  CF_FILES_PREFIX,
  cfNeutralDir,
  privateTempDir,
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
export type CfProcess = LongRunningProcess;

export interface CfStartCall {
  args: readonly string[];
  /** App root. */
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Keep stdout and stderr until `releaseOutput()`, e.g. a dev server's startup banner. */
  holdOutput?: boolean;
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

export function createCfRunner(options: CfRunnerOptions = {}): CfRunner {
  const resolveBinary = options.resolveBinary ?? resolveCfBinary;
  const baseEnv = options.env ?? process.env;
  const idleMs = options.watchdogIdleMs ?? DEFAULT_WATCHDOG_IDLE_MS;

  let nodeBinDir: Promise<string> | undefined;
  async function childEnv(
    plane: CfPlane,
    mode: CfOutputMode,
    extra: Record<string, string | undefined> = {},
  ): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      // cf otherwise hands the call to any cf it resolves from the working
      // directory; which cf runs is the runner's choice (./bin.ts).
      CF_DELEGATION: "1",
      ...(mode === "interactive" ? {} : { NO_COLOR: "1" }),
      ...(mode === "json" ? { CF_QUIET: "1" } : {}),
      ...(options.accountId
        ? { CLOUDFLARE_ACCOUNT_ID: options.accountId }
        : {}),
      // What cf builds or serves in the project runs on Node too.
      ...(plane === "project"
        ? { NODE_OPTIONS: buildNodeOptions(baseEnv["NODE_OPTIONS"]) }
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
        const env = await childEnv(call.plane, call.mode, call.env);
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
        await files?.remove();
      }
    },

    async start(call) {
      const binary = await resolveBinary(call.cwd);
      const env = await childEnv("project", "interactive", call.env);
      if (runsPackageManager(call.args)) {
        await assertToolchainNode(call.cwd, env);
      }
      return spawnLongRunning({
        command: process.execPath,
        args: [binary.path, ...call.args],
        cwd: call.cwd,
        env,
        hold: call.holdOutput ?? false,
      });
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

/** Every page of an account-plane list command, `perPage` at a time, up to `maxPages`. */
export async function listAll<T>(
  cf: CfRunner,
  args: readonly string[],
  schema: z.ZodType<T[]>,
  { perPage, maxPages }: { perPage: number; maxPages: number },
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await runCfJson(
      cf,
      {
        plane: "account",
        args: [...args, "--per-page", String(perPage), "--page", String(page)],
      },
      schema,
    );
    items.push(...batch);
    if (batch.length < perPage) break;
  }
  return items;
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
 * is interrupted: call `remove` once they're used.
 */
async function writePrivateFiles(files: Record<string, string | object>): Promise<{
  paths: Record<string, string>;
  remove: () => Promise<void>;
}> {
  const { dir, cleanup } = await privateTempDir(CF_FILES_PREFIX);
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
    await cleanup();
    throw error;
  }
  return { paths, remove: cleanup };
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
  // cf draws on the terminal itself: our spinner and open line make way.
  if (interactive) handTerminalOver();

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
              reject(new CfTimeoutError(command, timeoutMs, outputTail(stderr).at(-1)?.trim())),
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

    for (const [stream, append] of [
      [child.stdout, (text: string) => (stdout += text)],
      [child.stderr, (text: string) => (stderr += text)],
    ] as const) {
      stream?.on("data", (chunk: Buffer) => {
        append(chunk.toString());
        options.onOutput?.(chunk.toString());
        watch();
      });
    }

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
          : parseCfOutput(stderr, stdout);
        reject(new CfError(parsed, { exitCode: code, stderr, stdout }));
      });
    });
  });
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

function describe(args: CfCall["args"]): string {
  return typeof args === "function" ? "cf" : ["cf", ...args].join(" ");
}
