/**
 * One way to run a host process (docker, lsof, git) with its output streamed
 * line by line, so docker.ts and preflight.ts are tested with a fake that
 * records every argv and scripts the answer, and never start a process.
 */
import { spawn as nodeSpawn } from "node:child_process";
import readline from "node:readline";

export interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin, then stdin is closed; with nothing, stdin is closed at once (EOF). */
  stdin?: string;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type Spawn = (
  bin: string,
  args: string[],
  options?: SpawnOptions,
) => Promise<SpawnResult>;

/** The real thing: a child process, stdin closed, each stdout and stderr line to its callback. */
export const spawnProcess: Spawn = (bin, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(bin, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    readline
      .createInterface({ input: child.stdout })
      .on("line", (line) => options.onStdout?.(line));
    readline
      .createInterface({ input: child.stderr })
      .on("line", (line) => options.onStderr?.(line));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
    // A child that never reads stdin closes it on us: not an error here.
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });

interface Captured extends SpawnResult {
  stdout: string[];
  stderr: string[];
}

/** Runs and keeps every line, for commands whose whole output is the answer. */
export async function capture(
  spawn: Spawn,
  bin: string,
  args: string[],
  options: Omit<SpawnOptions, "onStdout" | "onStderr"> = {},
): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await spawn(bin, args, {
    ...options,
    onStdout: (line) => stdout.push(line),
    onStderr: (line) => stderr.push(line),
  });
  return { ...result, stdout, stderr };
}

export interface FakeCall {
  bin: string;
  args: string[];
  stdin: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
}

/** What a fake process does: exit code, lines, and an optional delay. */
export interface FakeAnswer {
  code?: number;
  signal?: NodeJS.Signals;
  stdout?: string[];
  stderr?: string[];
  delayMs?: number;
}

/**
 * A Spawn for tests: `script` gets each call and answers it; `calls` records
 * them all. A call the script does not answer exits 0 with no output.
 */
export function createFakeSpawn(
  script: (call: FakeCall) => FakeAnswer | undefined = () => undefined,
): { spawn: Spawn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const spawn: Spawn = async (bin, args, options = {}) => {
    const call: FakeCall = {
      bin,
      args,
      stdin: options.stdin,
      env: options.env,
    };
    calls.push(call);
    const answer = script(call) ?? {};
    if (answer.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    }
    for (const line of answer.stdout ?? []) options.onStdout?.(line);
    for (const line of answer.stderr ?? []) options.onStderr?.(line);
    return { code: answer.code ?? 0, signal: answer.signal ?? null };
  };
  return { spawn, calls };
}
