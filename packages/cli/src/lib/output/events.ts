/**
 * Progress events for commands that agents and scripts drive.
 *
 * With `--json`, stdout carries only these events, one JSON object per line
 * (NDJSON), each `{ v: 1, ts, type, … }`. People see a filter over the same
 * events instead (createHumanSink). A run ends with exit code 0 when done, 2
 * when it stopped on `action_required` (re-run the same command to resume
 * once the action is taken), and 1 after an error, whatever came before it.
 * Errors and actions end with the command to run next, `data.rerun`; an
 * error whose rerun takes something over (a flag like --force-dns) has
 * `data.authorize: true`: show it and ask before running it.
 *
 * An `action_required` with `data.waiting: true` is one the run waits for
 * (a login to approve, a setup link to open): pass its `url` and `code` to
 * a person and keep reading. If it is taken in time the run goes on and
 * ends `done` (exit 0), or with an error (exit 1) like any run; if not, a
 * last `action_required` ends it (exit 2).
 */
import chalk from "chalk";
import { onTerminalHandoff } from "./terminal";

type EventData = Record<string, unknown>;

type StepStatus = "start" | "ok" | "skip" | "fail";

/** Something only a person can do before the command can continue. */
export type RequiredAction =
  | "cloudflare_login"
  | "register_workers_subdomain"
  | "claim_owner"
  | "upgrade_workers_paid"
  | "rerun_interactive"
  | "add_domain"
  | "create_deploy_token";

interface ActionData extends EventData {
  url?: string;
  /** A one-time code to enter at `url` (device login). */
  code?: string;
  expiresAt?: string;
  /** The run waits for it, rather than stopping. */
  waiting?: boolean;
}

interface EventBase {
  v: 1;
  ts: string;
}

type EveryAppEvent = EventBase &
  (
    | {
        type: "step";
        step: string;
        status: StepStatus;
        message?: string;
        data?: EventData;
      }
    | { type: "progress"; step: string; message: string; data?: EventData }
    | {
        type: "warning";
        code: string;
        message: string;
        step?: string;
        data?: EventData;
      }
    | {
        type: "action_required";
        action: RequiredAction;
        message: string;
        step?: string;
        data?: ActionData;
      }
    | {
        type: "error";
        code: string;
        message: string;
        retryable: boolean;
        step?: string;
        data?: EventData;
      }
    | { type: "done"; message?: string; data?: EventData }
  );

/** Distributes over the union so each variant keeps its own fields. */
type EventInput<E> = E extends EveryAppEvent ? Omit<E, "v" | "ts"> : never;

export interface EventSink {
  emit(event: EventInput<EveryAppEvent>): void;
  /**
   * 1 once an error was emitted; else 2 once the run stopped on an action,
   * or while it waits for one (until it is done); else 0.
   */
  readonly exitCode: number;
}

/** Emit events as NDJSON lines on `write` (stdout by default). */
export function createNdjsonSink(
  write: (line: string) => void = (line) => process.stdout.write(line),
  now: () => Date = () => new Date(),
): EventSink {
  return trackExitCode((event) => {
    write(`${JSON.stringify({ v: 1, ts: now().toISOString(), ...event })}\n`);
  });
}

/**
 * How a person sees the same events: a filter over them, not a print of
 * each one.
 *
 *  - Steps: only the milestones below, each rendered from its data. Short
 *    ones join one line (`Built · 2 migrations applied · uploaded 3f9c1a2e`),
 *    with notes such as the database's restore point under it. Every other
 *    step is bookkeeping, shown with --verbose.
 *  - `step … start`: a spinner at a terminal, nothing when piped.
 *  - `progress`: with --verbose, except what a person must see whatever
 *    happens: the lease waits (who holds the lease), the certificate waits
 *    and the Gateway's release build, which takes a minute or two.
 *  - `warning`, `action_required`, `error` and `done`: always (a warning
 *    said twice in one run, once). Problems go to stderr, each ending with
 *    the command to run next (`data.rerun`); `done` lists `data.next` under
 *    "Next:".
 */
interface HumanSinkOptions {
  /** Bookkeeping steps and progress too (`--verbose`). */
  verbose?: boolean;
  /** stdout, written as is. */
  write?: (text: string) => void;
  /** stderr, for problems. */
  writeProblem?: (text: string) => void;
  /** stdout is a terminal: a spinner while a step runs, milestones drawn as they come. */
  terminal?: boolean;
  /** The terminal's width, so the line the spinner redraws never wraps. */
  columns?: () => number;
}

export function createHumanSink(options: HumanSinkOptions = {}): EventSink {
  const verbose = options.verbose ?? false;
  const terminal = options.terminal ?? false;
  const writeProblem =
    options.writeProblem ?? ((text: string) => void process.stderr.write(text));
  const screen = new Screen(
    options.write ?? ((text: string) => void process.stdout.write(text)),
    terminal,
    options.columns ?? (() => process.stdout.columns ?? 80),
  );
  if (terminal) onTerminalHandoff(() => screen.handOver());
  const problem = (lines: string[]) =>
    screen.aside(() => writeProblem(`${lines.join("\n")}\n`));
  // A check that runs twice in one deploy (the app's, then the gateway's)
  // says the same thing once.
  const warned = new Set<string>();

  return trackExitCode((event) => {
    switch (event.type) {
      case "step": {
        const shown = MILESTONES[event.step]?.(event) ?? null;
        if (event.status === "start") {
          if (shown && "open" in shown) screen.open(shown.open);
          else if (verbose && !terminal && event.message) {
            screen.lines(chalk.dim(event.message));
          }
          screen.spin(event.step, shown ? "" : spinnerLabel(event.message));
          return;
        }
        screen.stopSpinning(event.step);
        if (shown) show(screen, shown);
        else if (verbose && event.message) {
          screen.lines(chalk.dim(event.message));
        }
        return;
      }
      case "progress":
        if (SHOWN_PROGRESS[event.step]?.(event.data ?? {})) {
          screen.lines(event.message);
        } else if (verbose) screen.lines(chalk.dim(event.message));
        return;
      case "warning": {
        const seen = `${event.code}\n${event.message}`;
        if (warned.has(seen)) return;
        warned.add(seen);
        problem([
          chalk.yellow(`! ${indent(event.message)}`),
          ...nextCommand(event.data),
        ]);
        return;
      }
      case "action_required": {
        const lines = [
          chalk.yellow(event.message),
          ...(event.data?.url ? [`  ${chalk.cyan(event.data.url)}`] : []),
          ...(event.data?.code
            ? [`  Code: ${chalk.bold(event.data.code)}`]
            : []),
        ];
        if (event.data?.waiting) {
          // The run goes on once the person has done it.
          screen.lines(lines.join("\n"));
          screen.spin(event.step ?? event.action, "Waiting");
          return;
        }
        screen.finish();
        writeProblem(`${[...lines, ...nextCommand(event.data)].join("\n")}\n`);
        return;
      }
      case "error":
        screen.finish();
        writeProblem(
          `${[chalk.red(`✗ ${indent(event.message)}`), ...nextCommand(event.data)].join("\n")}\n`,
        );
        return;
      case "done": {
        screen.finish();
        const next = strings(event.data?.["next"]);
        const lines = [
          ...(event.message ? [chalk.green(event.message)] : []),
          ...next.map(
            (item, index) => `${index === 0 ? "Next: " : "      "}${item}`,
          ),
        ];
        if (lines.length > 0) screen.lines(lines.join("\n"));
        return;
      }
    }
  });
}

type StepEvent = Extract<EventInput<EveryAppEvent>, { type: "step" }>;

/** What a milestone adds to the screen. */
type Shown =
  /** Lines of their own. */
  | { line: string }
  /** A line the next milestones join, until one closes it. */
  | { open: string }
  /** Joins the open line, or starts one; `notes` print under it once it ends. */
  | { join: string; notes?: string[] }
  /** Ends the open line. */
  | { close: true };

/** The milestones: the steps a person sees, by name, and how. */
const MILESTONES: Readonly<Record<string, (event: StepEvent) => Shown | null>> =
  {
    "setup.account": (event) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      const who = [text(data["email"]), text(data["name"]) ?? text(data["id"])];
      return { line: `Cloudflare: ${who.filter(Boolean).join(" · ")}` };
    },
    "setup.gateway": (event) => {
      const data = event.data ?? {};
      const release = text(data["release"]);
      const from = text(data["from"]);
      if (event.status === "start") {
        return {
          open: !from
            ? `Installing the Gateway at ${text(data["gatewayUrl"])}`
            : from === release
              ? `Updating the Gateway ${release}`
              : `Upgrading the Gateway ${from} → ${release}`,
        };
      }
      if (event.status === "ok") return { close: true };
      if (event.status !== "skip") return null;
      if (data["upToDate"] === true) {
        return {
          line: `Gateway ${release} at ${text(data["gatewayUrl"])} is up to date.`,
        };
      }
      return event.message ? { line: event.message } : null;
    },
    "setup.login": (event) =>
      event.status === "ok" && event.message ? { line: event.message } : null,
    "gateway.migrations": migrated,
    "gateway.deploy": uploaded,
    "gateway.reconcile": (event) =>
      event.status === "skip" && event.message ? { line: event.message } : null,
    // What `gateway adopt` found: the point of its --dry-run.
    "gateway.adopt": (event) =>
      event.status === "ok" && event.message ? { line: event.message } : null,
    "app.register": (event) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      const appId = text(data["appId"]) ?? "The app";
      const organization = text(data["organizationName"]);
      const secrets = strings(data["secrets"]);
      const isNew = data["existingApp"] === false;
      const first = secrets.length
        ? `${isNew ? "Deploying" : "Redeploying"} ${appId} with ${secrets.join(", ")} (code and pending migrations from this directory)`
        : `${appId} → https://${text(data["hostname"])}${organization ? ` (${organization})` : ""}${isNew ? ", first deploy" : ""}`;
      if (!isNew) return { line: first };
      const access =
        data["defaultAccess"] === true
          ? `open to everyone${organization ? ` in ${organization}` : ""}`
          : "private to you, owners and admins";
      return {
        line: `${first}\nRegistered ${appId}: ${access} (change it in Admin → Apps)`,
      };
    },
    "app.build": (event) => (event.status === "ok" ? { join: "Built" } : null),
    "app.migrations": migrated,
    "app.upload": uploaded,
    "app.bind": (event) =>
      event.status === "start"
        ? { open: "Binding to the Gateway" }
        : event.status === "ok"
          ? { close: true }
          : null,
    "app.live": (event) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      return {
        line: `Live: ${text(data["url"]) ?? `https://${text(data["hostname"])}`}`,
      };
    },
    "app.delete": (event) =>
      event.status === "ok"
        ? {
            open: `Removed ${text(event.data?.["appId"]) ?? "the app"} from the Gateway`,
          }
        : null,
    "migrations.local": (event) => {
      if (event.status === "skip" && event.message)
        return { line: event.message };
      if (event.status !== "ok") return null;
      const applied = strings(event.data?.["applied"]);
      return {
        line: applied.length
          ? `${plural(applied.length, "migration")} applied to the local database`
          : "Local database up to date",
      };
    },
  };

const always = () => true;
/**
 * The certificate wait, not each certificate as it comes (`data.host`):
 * the next line says the app is live.
 */
const waiting = (data: EventData) => data["host"] === undefined;

/** Progress a person sees without --verbose, by step. */
const SHOWN_PROGRESS: Readonly<Record<string, (data: EventData) => boolean>> = {
  "app.lease": always,
  "gateway.lease": always,
  "gateway.release": always,
  "app.tls": waiting,
  "gateway.tls": waiting,
};

function migrated(event: StepEvent): Shown | null {
  if (event.status !== "ok") return null;
  const applied = strings(event.data?.["applied"]);
  const rollback = text(event.data?.["rollbackCommand"]);
  return applied.length
    ? {
        join: `${plural(applied.length, "migration")} applied`,
        notes: rollback ? [`  restore point: ${rollback}`] : [],
      }
    : { join: "database up to date" };
}

function uploaded(event: StepEvent): Shown | null {
  if (event.status !== "ok") return null;
  const version = text(event.data?.["versionId"])?.slice(0, 8);
  return { join: version ? `uploaded ${version}` : "uploaded" };
}

function show(screen: Screen, shown: Shown): void {
  if ("line" in shown) screen.lines(shown.line);
  else if ("open" in shown) screen.open(shown.open);
  else if ("join" in shown) screen.join(shown.join, shown.notes);
  else screen.endLine();
}

/** The command to run next, last under a problem. */
function nextCommand(data: EventData | undefined): string[] {
  const rerun = text(data?.["rerun"]);
  if (!rerun) return [];
  return [
    data?.["authorize"] === true
      ? `  To go ahead anyway: ${rerun}`
      : `  Then run: ${rerun}`,
  ];
}

/** A step's start message as its spinner's label: "Building the app...". */
function spinnerLabel(message: string | undefined): string {
  return (message ?? "").replace(/(\.\.\.|…)$/, "");
}

const indent = (message: string) => message.replace(/\n/g, "\n  ");
const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];
const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

/**
 * stdout for a person: lines, the open milestone line and, at a terminal,
 * the spinner of the step running, drawn at the end of the current line.
 * Piped, the open line is written once it ends and nothing spins.
 */
class Screen {
  private parts: string[] = [];
  private notes: string[] = [];
  /** Steps started and not finished, innermost last: the spinner shows it. */
  private running: Array<{ step: string; label: string }> = [];
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  /** The terminal's current line holds our drawing. */
  private drawn = false;

  constructor(
    private readonly write: (text: string) => void,
    private readonly terminal: boolean,
    private readonly columns: () => number,
  ) {}

  /** Lines of their own, once the open line has ended. */
  lines(text: string): void {
    this.endLine();
    this.erase();
    this.write(`${text}\n`);
    this.draw();
  }

  open(text: string): void {
    this.endLine();
    this.parts.push(text);
    this.draw();
  }

  join(text: string, notes: readonly string[] = []): void {
    this.parts.push(this.parts.length === 0 ? capitalize(text) : text);
    this.notes.push(...notes);
    this.draw();
  }

  /** End the open line, then its notes. */
  endLine(): void {
    if (this.parts.length === 0) return;
    this.erase();
    this.write(`${this.parts.join(" · ")}\n`);
    for (const note of this.notes) this.write(`${chalk.dim(note)}\n`);
    this.parts = [];
    this.notes = [];
    this.draw();
  }

  spin(step: string, label: string): void {
    this.running = [
      ...this.running.filter((run) => run.step !== step),
      { step, label },
    ];
    if (!this.terminal) return;
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        this.draw();
      }, FRAME_MS);
      this.timer.unref();
    }
    this.draw();
  }

  /** `step` finished, and with it whatever it started. */
  stopSpinning(step: string): void {
    const index = this.running.findIndex((run) => run.step === step);
    if (index < 0) return;
    this.running = this.running.slice(0, index);
    if (this.running.length === 0) this.stopTimer();
    this.draw();
  }

  /** Something writes to the terminal beside us (stderr): nothing of ours on its line meanwhile. */
  aside(writeIt: () => void): void {
    if (this.terminal) {
      this.endLine();
      this.erase();
    }
    writeIt();
    this.draw();
  }

  /** A prompt or an attached child takes the terminal: end the line, stop the spinner. */
  handOver(): void {
    this.running = [];
    this.stopTimer();
    this.endLine();
    this.erase();
  }

  /** The run's last word comes next. */
  finish(): void {
    this.handOver();
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private erase(): void {
    if (!this.drawn) return;
    this.write("\r\x1b[2K");
    this.drawn = false;
  }

  /** At a terminal: the open line so far, then the spinner, on the current line. */
  private draw(): void {
    if (!this.terminal) return;
    const line = this.parts.join(" · ");
    const run = this.running.at(-1);
    const spinner = run
      ? `${run.label ? `${line ? " · " : ""}${run.label} ` : line ? " " : ""}${FRAMES[this.frame]}`
      : "";
    if (!line && !spinner) {
      this.erase();
      return;
    }
    const width = Math.max(this.columns() - 1, 10);
    const plain = line + spinner;
    this.write(
      `\r\x1b[2K${
        plain.length > width
          ? `…${plain.slice(plain.length - width + 1)}`
          : `${line}${chalk.dim(spinner)}`
      }`,
    );
    this.drawn = true;
  }
}

function trackExitCode(
  write: (event: EventInput<EveryAppEvent>) => void,
): EventSink {
  let failed = false;
  let stopped = false;
  let waiting = false;
  return {
    emit(event) {
      if (event.type === "error") failed = true;
      else if (event.type === "action_required") {
        if (event.data?.waiting) waiting = true;
        else stopped = true;
      }
      // Done after the actions it waited for were taken.
      else if (event.type === "done") waiting = false;
      write(event);
    },
    get exitCode() {
      if (failed) return 1;
      return stopped || waiting ? 2 : 0;
    },
  };
}
