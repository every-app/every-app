/**
 * What Ctrl+C (SIGINT) or SIGTERM must not leave behind. Piped cf children
 * run in their own process groups, so the terminal's Ctrl+C reaches only
 * everyapp: cf would go on deploying, and the `finally` blocks that delete
 * secrets files and release the deploy lease would never
 * run (the next deploy would wait for the lease, then fail).
 *
 * While anything is registered here, the first SIGINT or SIGTERM:
 *  1. forwards the signal to every running cf child (its process group);
 *  2. waits for them to exit, then kills what's left;
 *  3. runs the synchronous cleanups (temp directories, secrets files);
 *  4. runs the asynchronous ones (recording an upload, then releasing the
 *     deploy lease it was made under) one at a time, last registered
 *     first, as `finally` blocks unwind, for a few seconds at most;
 *  5. runs the synchronous cleanups registered since, and exits with 130
 *     (SIGINT) or 143 (SIGTERM).
 * Meanwhile the interrupted code runs on (its `finally` blocks, a retry):
 * a cf child it starts is killed at once, since it would run without the
 * lease and outlive everyapp. Only the cleanups' own cf calls run. A
 * second Ctrl+C exits at once; a SIGTERM after the first signal (a CI
 * runner following its SIGINT up) lets the cleanup go on. With nothing
 * registered, Node's default applies. `everyapp dev` stops its own
 * `cf dev` through a cleanup, and says what it stops (sayOnInterrupt).
 *
 * Callers unregister a cleanup only once their own cleanup has finished:
 * stopping cf wakes up the code that was waiting for it, and its `finally`
 * may still be running when everyapp exits.
 *
 * What a person sees is the run's sink's to draw (lib/output/events.ts
 * registers with `onInterruptNotice`): a line built from what is being
 * stopped and cleaned up ("Stopping cf and freeing todo for other runs"),
 * from the running cf children and the cleanups' `label`s (one without a
 * label, like removing a temporary file, isn't worth saying), then a last
 * line: the newest cleanup's `closing`, if it has one, else "Stopped."
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { signalChild } from "@/lib/longRunning";
import { handTerminalOver } from "@/lib/output/terminal";
import { capitalize } from "@/lib/output/text";

interface Cleanup {
  /**
   * What it does, for a person: "freeing todo for other runs". Read when
   * the signal comes, so a command may change it as it goes ("stopping the
   * local migrations").
   */
  label?: string;
  /**
   * The run's last line once it stopped, if this cleanup knows better than
   * "Stopped." (what state a deploy was left in); "" when the command says
   * its own.
   */
  closing?: () => string | undefined;
  /** Must not wait: runs even when the async ones are cut short. */
  sync?: () => void;
  /** Best effort, bounded by {@link ASYNC_CLEANUP_MS}. */
  async?: () => Promise<void>;
}

interface TrackedChild {
  child: ChildProcess;
  /** It leads its own process group. */
  group: boolean;
  exited: Promise<void>;
}

const CHILD_EXIT_MS = 3_000;
const ASYNC_CLEANUP_MS = 10_000;
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** How the run's sink shows an interrupt. */
interface InterruptNotice {
  /** Stopping began: `message` says what is stopped and cleaned up. */
  stopping(message: string): void;
  /** Everything stopped; `closing` is the last line. */
  stopped(closing: string): void;
}

const children = new Set<TrackedChild>();
const notices = new Set<InterruptNotice>();
const cleanups = new Set<Cleanup>();
const cleanedUp = new WeakSet<Cleanup>();
// Set while the interrupt's own cleanups run.
const cleaningUp = new AsyncLocalStorage<true>();
let installed = false;
let interrupted = false;
// What the first signal says it stops, when the command says (sayOnInterrupt).
let saying: string | undefined;

/** Stop `child` (and its group) on an interrupt; call the result once it exits. */
export function trackChild(child: ChildProcess, group: boolean): () => void {
  const tracked: TrackedChild = {
    child,
    group,
    exited: new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("close", () => resolve());
    }),
  };
  if (interrupted && !cleaningUp.getStore()) send(tracked, "SIGKILL");
  children.add(tracked);
  updateHandlers();
  return () => {
    children.delete(tracked);
    updateHandlers();
  };
}

/** Whether a SIGINT or SIGTERM is being handled: what's left is its to do. */
export function isInterrupted(): boolean {
  return interrupted;
}

/**
 * What the first signal says it is stopping ("the local migrations"; "" for
 * nothing), instead of deploy's sentence; call the result to go back.
 */
export function sayOnInterrupt(stopping: string): () => void {
  saying = stopping;
  return () => {
    if (saying === stopping) saying = undefined;
  };
}

/** Run `cleanup` on an interrupt; call the result once it's no longer needed. */
export function onInterrupt(cleanup: Cleanup): () => void {
  cleanups.add(cleanup);
  updateHandlers();
  return () => {
    cleanups.delete(cleanup);
    updateHandlers();
  };
}

/** The run's sink shows interrupts; returns how to stop. */
export function onInterruptNotice(notice: InterruptNotice): () => void {
  notices.add(notice);
  return () => notices.delete(notice);
}

/** "Stopping cf and freeing todo for other runs", from what's running and registered. */
function stoppingMessage(): string {
  const labels = [...new Set([...cleanups].flatMap((cleanup) => (cleanup.label ? [cleanup.label] : [])))];
  // cf is what a cleanup that says it stops something stops.
  const doing = [
    ...(children.size > 0 && !labels.some((label) => label.startsWith("stopping ")) ? ["stopping cf"] : []),
    ...labels,
  ];
  if (doing.length === 0) return "Stopping";
  const said =
    doing.length === 1 ? doing[0]! : `${doing.slice(0, -1).join(", ")} and ${doing.at(-1)}`;
  return capitalize(said);
}

/** The newest cleanup's closing line, else "Stopped." */
function closingLine(registered: readonly Cleanup[]): string {
  for (const cleanup of [...registered].reverse()) {
    const closing = cleanup.closing?.();
    if (closing !== undefined) return closing;
  }
  return "Stopped.";
}

function tell(how: (notice: InterruptNotice) => void, fallback: string): void {
  if (notices.size === 0) process.stderr.write(fallback);
  for (const notice of notices) how(notice);
}

function updateHandlers(): void {
  const needed = children.size > 0 || cleanups.size > 0;
  if (needed === installed || interrupted) return;
  installed = needed;
  for (const signal of SIGNALS) {
    if (needed) process.on(signal, onSignal);
    else process.off(signal, onSignal);
  }
}

function onSignal(signal: NodeJS.Signals): void {
  void handleInterrupt(signal);
}

/** Exported for tests, which pass their own `exit`. */
export async function handleInterrupt(
  signal: NodeJS.Signals,
  { exit = (code: number) => process.exit(code) }: { exit?: (code: number) => void } = {},
): Promise<void> {
  const code = signal === "SIGTERM" ? 143 : 130;
  if (interrupted) {
    // A CI runner sends SIGTERM some seconds after its SIGINT (GitHub
    // Actions: 7.5), then SIGKILL: until then, the cleanup goes on.
    if (signal === "SIGTERM") return;
    // A second Ctrl+C: don't wait for anything.
    for (const tracked of children) send(tracked, "SIGKILL");
    runSyncCleanups();
    exit(code);
    return;
  }
  interrupted = true;
  // A spinner would be drawn over what follows.
  handTerminalOver();
  // What the command said it stops (sayOnInterrupt; "" for nothing), else
  // what's running and registered.
  // A command that says what it stops (sayOnInterrupt) says its own last line too.
  const said = saying;
  const message = said === undefined ? stoppingMessage() : said ? `Stopping ${said}` : "";
  if (message) {
    tell((notice) => notice.stopping(message), `\n${message} (Ctrl+C again to quit at once)...\n`);
  }
  // The closing line is decided by what was registered when stopping began.
  const registered = [...cleanups];

  const running = [...children];
  for (const tracked of running) send(tracked, signal);
  const allExited = Promise.all(running.map((tracked) => tracked.exited));
  if (!(await settlesWithin(allExited, CHILD_EXIT_MS))) {
    for (const tracked of running) send(tracked, "SIGKILL");
    await settlesWithin(allExited, 1_000);
  }

  runSyncCleanups();
  await settlesWithin(runAsyncCleanups(), ASYNC_CLEANUP_MS);
  // What the interrupted code registered meanwhile (a secrets file it
  // went on to write).
  runSyncCleanups();
  if (said === undefined) {
    const closing = closingLine(registered);
    tell((notice) => notice.stopped(closing), closing ? `${closing}\n` : "");
  }
  exit(code);
}

/**
 * The asynchronous cleanups, last registered first and one at a time: an
 * upload is recorded before the lease it was made under is freed, so a
 * deploy waiting for that lease reads the record.
 */
async function runAsyncCleanups(): Promise<void> {
  for (const cleanup of [...cleanups].reverse()) {
    if (!cleanup.async) continue;
    await cleaningUp.run(true, () => cleanup.async!()).catch(() => undefined);
  }
}

/** Each synchronous cleanup not run yet. */
function runSyncCleanups(): void {
  for (const cleanup of [...cleanups]) {
    if (cleanedUp.has(cleanup)) continue;
    cleanedUp.add(cleanup);
    try {
      cleanup.sync?.();
    } catch {
      // Best effort: the next cleanup still runs.
    }
  }
}

function send({ child, group }: TrackedChild, signal: NodeJS.Signals): void {
  signalChild(child, group, signal);
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Forget everything and stop handling signals (tests). */
export function resetInterruptsForTests(): void {
  children.clear();
  cleanups.clear();
  notices.clear();
  interrupted = false;
  saying = undefined;
  updateHandlers();
}
