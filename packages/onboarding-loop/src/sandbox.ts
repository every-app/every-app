/**
 * Helpers around the Sandbox interface (types.ts): the 600 env file that
 * carries the secrets into a container for seconds, a capture helper for
 * commands whose whole output is the answer, and FakeSandbox, which every
 * test of a step that runs something in a container uses instead of docker.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DiffEntry,
  ExecLine,
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxHandle,
  SandboxSpec,
  TailHandle,
} from "./types";

/** `loop-<runId>` with only what docker accepts in a name: the harness's container. */
export const containerName = (runId: string): string =>
  `loop-${runId.replace(/[^a-zA-Z0-9_.-]/g, "")}`.slice(0, 60);

/** The prefix of every sibling container a run creates (`loop-sib-<label>-<rand>`); preflight and gc keep those of a live run. */
export const siblingContainerPrefix = (runId: string): string => {
  const label = runId
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}-/, "")
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 24);
  return `loop-sib-${label}-`;
};

/** A container a run that still holds its lock owns: never removed by another driver's preflight or by gc. */
export function containerOwnedByRun(name: string, runIds: string[]): boolean {
  return runIds.some(
    (runId) =>
      name === containerName(runId) ||
      name.startsWith(siblingContainerPrefix(runId)),
  );
}

/**
 * Writes `KEY=value` lines to a new file only this user can read (dir 700,
 * file 600), for `docker create --env-file`. The caller deletes it the
 * moment the container exists. Values must not contain newlines.
 */
export function writeSecretEnvFile(env: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-loop-env-"));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "env");
  const lines = Object.entries(env).map(([key, value]) => {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${key} contains a newline; it can't go in an env file.`);
    }
    return `${key}=${value}`;
  });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

/** Removes the env file and its directory; a missing file is fine. */
export function removeSecretEnvFile(file: string): void {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

export interface ExecCapture {
  result: ExecResult;
  stdout: string[];
  stderr: string[];
}

/** Runs and keeps every (redacted) line. */
export async function execCapture(
  sandbox: Sandbox,
  handle: SandboxHandle,
  argv: string[],
  options: Omit<ExecOptions, "onLine"> = {},
): Promise<ExecCapture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await sandbox.exec(handle, argv, {
    ...options,
    onLine: (line) =>
      (line.stream === "stdout" ? stdout : stderr).push(line.line),
  });
  return { result, stdout, stderr };
}

/** What a fake exec answers: exit code, lines, an optional delay, or a hang until aborted. */
export interface FakeExecAnswer {
  code?: number;
  stdout?: string[];
  stderr?: string[];
  delayMs?: number;
  /** Never exits on its own: ends only through the exec's AbortSignal or timeout. */
  hang?: boolean;
}

export interface FakeExecCall {
  name: string;
  argv: string[];
  options: ExecOptions;
}

/**
 * A Sandbox for tests. `script` answers each exec; everything is recorded.
 * `pushTail` feeds a line to whoever tails a file (the scripted user's
 * event-log tail). No process, no docker, no file.
 */
export class FakeSandbox implements Sandbox {
  readonly created: SandboxSpec[] = [];
  readonly started: string[] = [];
  readonly execs: FakeExecCall[] = [];
  readonly copiedIn: Array<{
    name: string;
    hostPath: string;
    sandboxPath: string;
  }> = [];
  readonly copiedOut: Array<{
    name: string;
    sandboxPath: string;
    hostPath: string;
  }> = [];
  readonly destroyed: string[] = [];
  readonly tails: Array<{ name: string; path: string; closed: boolean }> = [];
  diffEntries: DiffEntry[] = [];

  private readonly tailListeners = new Map<
    string,
    Array<(line: string) => void>
  >();
  /** Hanging execs per container, ended by `destroy` the way `docker rm -f` ends a real one. */
  private readonly hanging = new Map<string, Array<() => void>>();

  constructor(
    private readonly script: (
      call: FakeExecCall,
    ) => FakeExecAnswer | undefined = () => undefined,
  ) {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    this.started.push(spec.name);
    return { id: `fake-${randomUUID().slice(0, 8)}`, name: spec.name };
  }

  async copyIn(
    handle: SandboxHandle,
    hostPath: string,
    sandboxPath: string,
  ): Promise<void> {
    this.copiedIn.push({ name: handle.name, hostPath, sandboxPath });
  }

  async exec(
    handle: SandboxHandle,
    argv: string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const call: FakeExecCall = { name: handle.name, argv, options };
    this.execs.push(call);
    const answer = this.script(call) ?? {};
    const startedAt = Date.now();
    const emit = (
      stream: ExecLine["stream"],
      lines: string[] | undefined,
    ): void => {
      for (const line of lines ?? []) {
        options.onLine?.({
          stream,
          line,
          receivedAt: new Date().toISOString(),
        });
      }
    };
    emit("stdout", answer.stdout);
    emit("stderr", answer.stderr);
    if (answer.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    }
    if (answer.hang) {
      const killed = await new Promise<boolean>((resolve) => {
        const timer =
          options.timeoutMs !== undefined
            ? setTimeout(() => resolve(true), options.timeoutMs)
            : null;
        const end = (): void => {
          if (timer) clearTimeout(timer);
          resolve(true);
        };
        options.signal?.addEventListener("abort", end);
        const ends = this.hanging.get(handle.name) ?? [];
        ends.push(end);
        this.hanging.set(handle.name, ends);
      });
      return {
        exitCode: 137,
        signal: "SIGKILL",
        durationMs: Date.now() - startedAt,
        killed,
      };
    }
    return {
      exitCode: answer.code ?? 0,
      signal: null,
      durationMs: Date.now() - startedAt,
      killed: false,
    };
  }

  async tailFile(
    handle: SandboxHandle,
    sandboxPath: string,
    onLine: (line: string) => void,
  ): Promise<TailHandle> {
    const entry = { name: handle.name, path: sandboxPath, closed: false };
    this.tails.push(entry);
    const listeners = this.tailListeners.get(sandboxPath) ?? [];
    listeners.push(onLine);
    this.tailListeners.set(sandboxPath, listeners);
    return {
      close: async () => {
        entry.closed = true;
        this.tailListeners.set(
          sandboxPath,
          (this.tailListeners.get(sandboxPath) ?? []).filter(
            (listener) => listener !== onLine,
          ),
        );
      },
    };
  }

  /** A line appears in a tailed file. */
  pushTail(sandboxPath: string, line: string): void {
    for (const listener of this.tailListeners.get(sandboxPath) ?? [])
      listener(line);
  }

  async copyOut(
    handle: SandboxHandle,
    sandboxPath: string,
    hostPath: string,
  ): Promise<void> {
    this.copiedOut.push({ name: handle.name, sandboxPath, hostPath });
  }

  async diff(_handle: SandboxHandle): Promise<DiffEntry[]> {
    return [...this.diffEntries];
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.destroyed.push(handle.name);
    for (const end of this.hanging.get(handle.name) ?? []) end();
    this.hanging.delete(handle.name);
  }

  /** Containers created and not destroyed: what a cleanup must leave none of. */
  get running(): string[] {
    return this.started.filter((name) => !this.destroyed.includes(name));
  }
}
