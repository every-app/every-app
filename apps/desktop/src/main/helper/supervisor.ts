// Runs `everyapp-helper` and speaks helper protocol v1 with it (docs/desktop-plan.md): one JSON
// object per line on stdin/stdout, logs on stderr. Restarts it with backoff when it dies, answers
// `token.needed` with a fresh access token, and re-sends call detection after a restart.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import {
  HELPER_PROTOCOL,
  parseHelperLine,
  type HelperCommand,
  type HelperCommands,
  type HelperEvent,
  type HelperResponse,
} from "@shared/protocol";
import type { HelperSnapshot } from "@shared/ipc";

export class HelperRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HelperRequestError";
  }
}

export interface SupervisorOptions {
  /** The helper binary, or a .js/.mjs script (run with this process's Node/Electron as Node). */
  path: string;
  /** A fresh access token for `token.needed`; undefined when signed out. */
  freshToken: () => Promise<string | undefined>;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** A helper that stays up this long resets the backoff. */
  stableAfterMs?: number;
  requestTimeoutMs?: number;
  /** How long stdin EOF gets before SIGTERM on stop. */
  stopGraceMs?: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** Commands that may wait on a person (a permission prompt) or the network (the last post). */
const SLOW: Partial<Record<HelperCommand, number>> = {
  "permissions.request": 5 * 60_000,
  "record.start": 60_000,
  // Stop waits for the helper to transcribe audio kept through an outage (at most 5 minutes per
  // speaker in ≤ 30 s chunks, each up to 3 tries of ≤ 60 s) before /finish. Usually seconds;
  // this only stops main from calling a slow save a failure.
  "record.stop": 20 * 60_000,
  // Up to 60 s of capture, plus a first-time mic or system-audio prompt waiting on the person.
  "selftest.run": 6 * 60_000,
  // One request to the person's own server; a cold model can take a while.
  "transcribe.test": 75_000,
};

export interface SupervisorEvents {
  event: [HelperEvent];
  status: [HelperSnapshot];
  /** The helper died; `wasRecording` if it held a recording at the time. */
  exit: [{ code: number | null; signal: NodeJS.Signals | null; wasRecording: boolean }];
}

export class HelperSupervisor extends EventEmitter<SupervisorEvents> {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private backoff: number;
  private restartTimer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private recording = false;
  private detectEnabled: boolean | undefined;
  private snapshot: HelperSnapshot = { status: "stopped", restarts: 0, crashes: 0 };

  constructor(private readonly options: SupervisorOptions) {
    super();
    this.backoff = options.initialBackoffMs ?? 1000;
  }

  get state(): HelperSnapshot {
    return this.snapshot;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  start(): void {
    this.stopping = false;
    if (this.child) return;
    this.spawnChild();
  }

  /** Sends a request; resolves with its result or rejects with HelperRequestError. */
  request<C extends HelperCommand>(cmd: C, params?: HelperCommands[C]["params"]): Promise<HelperCommands[C]["result"]> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new HelperRequestError("helper_unavailable", "Every App's recorder isn't running."));
    }
    const id = this.nextId++;
    const line = JSON.stringify(params === undefined ? { id, cmd } : { id, cmd, params });
    return new Promise((resolve, reject) => {
      const timeout = SLOW[cmd] ?? this.options.requestTimeoutMs ?? 15_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperRequestError("timeout", `The recorder didn't answer ${cmd}.`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(`${line}\n`);
    });
  }

  /** Reads the permissions and keeps them in the snapshot. */
  async refreshPermissions(): Promise<NonNullable<HelperSnapshot["permissions"]>> {
    const permissions = await this.request("permissions.status");
    this.setStatus({ permissions });
    return permissions;
  }

  /** Asks macOS for a permission (shows its prompt the first time). */
  async requestPermission(kind: "mic" | "systemAudio"): Promise<NonNullable<HelperSnapshot["permissions"]>> {
    const permissions = await this.request("permissions.request", { kind });
    this.setStatus({ permissions });
    return permissions;
  }

  /** Call detection on or off; remembered and re-sent after a restart. */
  async setDetection(enabled: boolean): Promise<void> {
    this.detectEnabled = enabled;
    if (this.snapshot.status === "ready") await this.request("detect.set", { enabled });
  }

  /** Stops the helper for good (app quit): closes stdin (it then stops any recording cleanly and
   * exits, within 45 s), SIGTERM after `stopGraceMs`, SIGKILL 50 s after that as a last resort. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    const child = this.child;
    if (!child) return this.setStatus({ status: "stopped" });
    await new Promise<void>((resolve) => {
      const grace = this.options.stopGraceMs ?? 10_000;
      const kill = setTimeout(() => child.kill("SIGKILL"), grace + 50_000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
      setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), grace);
    });
  }

  private spawnChild(): void {
    const { path } = this.options;
    const isScript = /\.(c|m)?js$/.test(path);
    const command = isScript ? process.execPath : path;
    const args = isScript ? [path] : [];
    const env = { ...process.env, ...this.options.env, ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
    this.setStatus({ status: "starting" });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      this.setStatus({ status: "unavailable", lastError: String(error) });
      return;
    }
    this.child = child;
    child.stdin.on("error", () => {}); // EPIPE when it dies mid-write; the exit handler takes over.
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => this.options.log?.(`[helper] ${line}`));
    child.once("error", (error: NodeJS.ErrnoException) => {
      this.options.log?.(`helper failed to start: ${error.message}`);
      if (error.code === "ENOENT" || error.code === "EACCES") {
        // Not there or not executable: restarting won't help.
        this.stopping = true;
        this.child = undefined;
        this.setStatus({ status: "unavailable", lastError: `The recorder isn't installed (${path}).` });
      }
    });
    child.once("spawn", () => void this.handshake(child));
    child.once("exit", (code, signal) => this.onExit(child, code, signal));
  }

  private async handshake(child: ChildProcessWithoutNullStreams): Promise<void> {
    try {
      const hello = await this.request("hello", { protocol: HELPER_PROTOCOL });
      if (this.child !== child) return;
      if (hello.protocol !== HELPER_PROTOCOL) {
        this.stopping = true;
        this.setStatus({
          status: "unavailable",
          lastError: `The recorder speaks protocol ${hello.protocol}, Every App speaks ${HELPER_PROTOCOL}.`,
        });
        child.kill("SIGTERM");
        return;
      }
      this.setStatus({ status: "ready", version: hello.version, macos: hello.macos, lastError: undefined });
      this.options.log?.(`helper ready: ${this.options.path} ${hello.version} (macOS ${hello.macos})`);
      this.stableTimer = setTimeout(() => {
        this.backoff = this.options.initialBackoffMs ?? 1000;
      }, this.options.stableAfterMs ?? 60_000);
      if (this.detectEnabled !== undefined) await this.request("detect.set", { enabled: this.detectEnabled });
      await this.refreshPermissions();
    } catch (error) {
      this.options.log?.(`helper handshake failed: ${String(error)}`);
      if (this.child === child && this.snapshot.status === "starting") child.kill("SIGTERM");
    }
  }

  private onLine(line: string): void {
    const message = parseHelperLine(line);
    if (!message) {
      this.options.log?.(`helper sent a line that isn't protocol: ${line.slice(0, 200)}`);
      return;
    }
    if (message.kind === "response") this.onResponse(message.response);
    else this.onEvent(message.event);
  }

  private onResponse(response: HelperResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result ?? {});
    else pending.reject(new HelperRequestError(response.error?.code ?? "error", response.error?.message ?? "The recorder failed."));
  }

  private onEvent(event: HelperEvent): void {
    if (event.event === "state") this.recording = event.recording;
    if (event.event === "token.needed") void this.answerTokenNeeded();
    this.emit("event", event);
  }

  private async answerTokenNeeded(): Promise<void> {
    try {
      const accessToken = await this.options.freshToken();
      if (accessToken) await this.request("token.update", { accessToken });
    } catch (error) {
      this.options.log?.(`couldn't answer token.needed: ${String(error)}`);
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    clearTimeout(this.stableTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HelperRequestError("helper_exited", "Every App's recorder stopped."));
    }
    this.pending.clear();
    const wasRecording = this.recording;
    this.recording = false;
    this.emit("exit", { code, signal, wasRecording });
    if (this.stopping) {
      if (this.snapshot.status !== "unavailable") this.setStatus({ status: "stopped" });
      return;
    }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 30_000);
    this.options.log?.(`helper exited (code ${code}, signal ${signal}); restarting in ${delay} ms`);
    this.setStatus({
      status: "restarting",
      restarts: this.snapshot.restarts + 1,
      crashes: this.snapshot.crashes + 1,
      lastError: `The recorder stopped (${signal ?? `exit ${code}`}).`,
    });
    this.restartTimer = setTimeout(() => {
      if (!this.stopping) this.spawnChild();
    }, delay);
  }

  private setStatus(patch: Partial<HelperSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("status", this.snapshot);
  }
}
