/**
 * Long-running children (`cf dev`, an app's own dev command), each in its own
 * process group so stopping it also stops what it started (the package
 * manager, Vite, workerd).
 */
import chalk from "chalk";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

/** Windows has no process groups to signal; children are stopped one by one. */
export const PROCESS_GROUPS = process.platform !== "win32";
const KILL_GRACE_MS = 1_000;

export interface LongRunningProcess {
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  /** Signal the whole process group. */
  stop(signal?: NodeJS.Signals): void;
  /**
   * With `hold`: pass output through from now on, after what was held
   * (`startup: true`) or without it.
   */
  releaseOutput(startup: boolean): void;
}

interface SpawnLongRunningOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `command` is a shell command line (a manifest's dev command). */
  shell?: boolean;
  /** Keep stdout and stderr until `releaseOutput()`, e.g. a dev server's startup banner. */
  hold: boolean;
}

export function spawnLongRunning({
  command,
  args,
  cwd,
  env,
  shell = false,
  hold,
}: SpawnLongRunningOptions): LongRunningProcess {
  const child = spawn(command, args, {
    cwd,
    shell,
    // Output goes straight to the terminal, so it keeps its colors; held
    // output asks for them.
    env: hold && chalk.level > 0 ? { ...env, FORCE_COLOR: "1" } : env,
    // No stdin: a detached group reading the terminal would be stopped
    // with SIGTTIN.
    stdio: ["ignore", hold ? "pipe" : "inherit", hold ? "pipe" : "inherit"],
    detached: PROCESS_GROUPS,
  });
  let held: Array<{ to: NodeJS.WriteStream; chunk: Buffer }> | null = hold ? [] : null;
  // Held output can trail the exit: what explains a failed start comes last.
  const drained = hold
    ? Promise.race([
        Promise.all([once(child.stdout!, "end"), once(child.stderr!, "end")]),
        new Promise((resolve) => setTimeout(resolve, 1000).unref()),
      ])
    : Promise.resolve();
  if (hold) {
    for (const [from, to] of [
      [child.stdout!, process.stdout],
      [child.stderr!, process.stderr],
    ] as const) {
      from.on("data", (chunk: Buffer) => {
        if (held) held.push({ to, chunk });
        else to.write(chunk);
      });
    }
  }
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      void drained.then(() => resolve({ code, signal }));
    });
  });
  return {
    exited,
    stop: (signal) => stopChild(child, PROCESS_GROUPS, signal),
    releaseOutput: (startup) => {
      const kept = held ?? [];
      held = null;
      if (startup) for (const { to, chunk } of kept) to.write(chunk);
    },
  };
}

/**
 * Signal a child, or its whole process group when it leads one, and escalate
 * to SIGKILL if it outlives the grace period.
 */
export function stopChild(
  child: ChildProcess,
  group: boolean,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (child.pid === undefined) return;
  signalChild(child, group, signal);
  if (signal !== "SIGKILL") {
    setTimeout(() => signalChild(child, group, "SIGKILL"), KILL_GRACE_MS).unref();
  }
}

/** Signal a child, or its whole process group when it leads one; one that's gone is left be. */
export function signalChild(
  child: ChildProcess,
  group: boolean,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (group) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}
