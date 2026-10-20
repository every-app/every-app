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
import cliCursor from "cli-cursor";
import { formatFacts } from "./table";
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
  | "choose_account"
  | "install_gateway";

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
    | {
        type: "done";
        message?: string;
        data?: EventData;
        /** How a person sees the result, drawn by the command (tables); never in --json. */
        display?: string;
      }
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
  /** A person passed --verbose: cf deploys run attached to their terminal. */
  readonly verbose: boolean;
}

/** Emit events as NDJSON lines on `write` (stdout by default). */
export function createNdjsonSink(
  write: (line: string) => void = (line) => process.stdout.write(line),
  now: () => Date = () => new Date(),
): EventSink {
  return trackExitCode((event) => {
    // `display` is drawn for a person; a script reads `data`.
    const line = event.type === "done" ? { ...event, display: undefined } : event;
    write(`${JSON.stringify({ v: 1, ts: now().toISOString(), ...line })}\n`);
  }, false);
}

/**
 * How a person sees the same events: a filter over them, not a print of
 * each one.
 *
 *  - Steps: only the milestones below, each rendered from its data. A
 *    finished step gets a ticked line of its own (`Built ✓ 4.2s`), with its
 *    time when it took a second or more, and notes such as the database's
 *    restore point under it. Facts (`Live`) wait for the end of the run.
 *    Every other step is bookkeeping, shown with --verbose.
 *  - `step … start`: a spinner after its message at a terminal (the cursor
 *    hidden meanwhile), nothing when piped.
 *  - `progress`: with --verbose, except the waits a person must see (who
 *    holds a lease, a certificate, the Gateway's build): at a terminal one
 *    line redrawn in place, piped once; and `everyapp dev`'s log lines.
 *  - `warning`, `action_required`, `error` and `done`: always (a warning
 *    said twice in one run, once). Each problem is a one-line headline, its
 *    detail dim under it, then what to do: `data.fix`, then the command to
 *    run (`data.rerun`). Problems go to stderr. `done` ends with the facts,
 *    the run's time when it took 10 seconds or more, and `data.next`.
 */
interface HumanSinkOptions {
  /** Bookkeeping steps and progress too (`--verbose`). */
  verbose?: boolean;
  /** stdout, written as is. */
  write?: (text: string) => void;
  /** stderr, for problems. */
  writeProblem?: (text: string) => void;
  /** stdout is a terminal: a spinner while a step runs, the cursor hidden. */
  terminal?: boolean;
  /** The terminal's width, so the line the spinner redraws never wraps. */
  columns?: () => number;
  /** Milliseconds now, for the times steps and the run took. */
  now?: () => number;
}

export function createHumanSink(options: HumanSinkOptions = {}): EventSink {
  const verbose = options.verbose ?? false;
  const terminal = options.terminal ?? false;
  const now = options.now ?? Date.now;
  const began = now();
  const writeProblem =
    options.writeProblem ?? ((text: string) => void process.stderr.write(text));
  const screen = new Screen(
    options.write ?? ((text: string) => void process.stdout.write(text)),
    terminal,
    options.columns ?? (() => process.stdout.columns ?? 80),
    now,
  );
  if (terminal) onTerminalHandoff(() => screen.handOver());
  const problem = (lines: string[]) =>
    screen.aside(() => writeProblem(`${lines.join("\n")}\n`));
  // A check that runs twice in one deploy (the app's, then the gateway's)
  // says the same thing once.
  const warned = new Set<string>();
  // When each running step started, for the time its ticked line shows.
  const started = new Map<string, number>();
  // Waits drawn as a spinner (or, piped, said once); each ends at the next step.
  const waits = new Set<string>();
  // The run's facts, shown together once it is done.
  const facts: Fact[] = [];

  const show = (items: readonly Shown[], took?: number) => {
    for (const item of items) {
      if ("line" in item) screen.lines(item.line);
      else if ("fact" in item) facts.splice(item.lead ? 0 : facts.length, 0, item.fact);
      else if ("done" in item) {
        const after =
          item.detail ?? (took !== undefined && took >= 1000 ? duration(took) : "");
        screen.lines(
          [
            `${item.done} ${chalk.green("✓")}${after ? ` ${chalk.dim(after)}` : ""}`,
            ...(item.notes ?? []).map((note) => chalk.dim(`  ${note}`)),
          ].join("\n"),
        );
      }
    }
  };

  return trackExitCode((event) => {
    switch (event.type) {
      case "step": {
        for (const wait of waits) {
          if (wait === event.step) continue;
          screen.drop(wait);
          waits.delete(wait);
          started.delete(wait);
        }
        const found = MILESTONES[event.step]?.(event, (step) => started.has(step));
        const shown = found ? [found].flat() : [];
        if (event.status === "start") {
          started.set(event.step, now());
          const spin = shown.find((item) => "spin" in item);
          if (shown.length === 0 && verbose && !terminal && event.message) {
            screen.lines(chalk.dim(event.message));
          }
          show(shown);
          screen.spin(
            event.step,
            spin ? spin.spin : shown.length > 0 ? "" : (event.message ?? ""),
          );
          return;
        }
        const since = started.get(event.step);
        started.delete(event.step);
        waits.delete(event.step);
        screen.stopSpinning(event.step);
        if (shown.length > 0) {
          show(shown, since === undefined ? undefined : now() - since);
        } else if (verbose && event.message) {
          screen.lines(chalk.dim(event.message));
        }
        return;
      }
      case "progress":
        if (LOGGED_PROGRESS.has(event.step)) screen.lines(chalk.dim(event.message));
        else if (SHOWN_PROGRESS[event.step]?.(event.data ?? {})) {
          if (!started.has(event.step)) started.set(event.step, now());
          if (terminal) screen.spin(event.step, event.message);
          else if (!waits.has(event.step)) screen.lines(event.message);
          waits.add(event.step);
        } else if (verbose) screen.lines(chalk.dim(event.message));
        return;
      case "warning": {
        const seen = `${event.code}\n${event.message}`;
        if (warned.has(seen) || (QUIET_WARNINGS.has(event.code) && !verbose)) return;
        warned.add(seen);
        problem([
          ...headed(chalk.yellow("!"), event.message),
          ...nextCommand(event.data, "Run"),
        ]);
        return;
      }
      case "action_required": {
        const [headline = "", ...detail] = event.message.split("\n");
        const lines = [
          `${chalk.cyan("→")} ${headline}`,
          ...(event.data?.url ? [`  ${chalk.cyan(event.data.url)}`] : []),
          ...(event.data?.code
            ? [`  Code: ${chalk.bold(event.data.code)}`]
            : []),
          ...detail.map((line) => chalk.dim(`  ${line}`)),
        ];
        if (event.data?.waiting) {
          // The run goes on once the person has done it.
          const step = event.step ?? event.action;
          screen.lines(lines.join("\n"));
          started.set(step, now());
          const what = text(event.data["waitingFor"]);
          screen.spin(step, what ? `Waiting for ${what}` : "Waiting");
          return;
        }
        screen.finish();
        writeProblem(`${[...lines, ...nextCommand(event.data, "Then run")].join("\n")}\n`);
        return;
      }
      case "error":
        screen.finish();
        writeProblem(
          `${[...headed(chalk.red("✗"), event.message), ...nextCommand(event.data, "Run")].join("\n")}\n`,
        );
        return;
      case "done": {
        screen.finish();
        const took = now() - began;
        const allFacts = [...facts, ...factsIn(event.data?.["facts"])];
        const next = nextItems(event.data?.["next"]);
        const lines = [
          ...(event.display !== undefined
            ? [event.display]
            : event.message
              ? [chalk.green(event.message)]
              : []),
          ...(allFacts.length > 0 ? ["", ...formatFacts(allFacts)] : []),
          ...(took >= 10_000 && event.display === undefined
            ? [chalk.dim(`Done in ${duration(took)}`)]
            : []),
          ...(next.length > 0 ? ["", "Next:", ...formatNext(next)] : []),
        ];
        if (lines.length > 0) screen.lines(lines.join("\n"));
        return;
      }
    }
  }, verbose);
}

type StepEvent = Extract<EventInput<EveryAppEvent>, { type: "step" }>;

/** What a milestone adds to the screen. */
type Shown =
  /** Lines of their own. */
  | { line: string }
  /** A step done: a ticked line, `detail` (else its time) after the tick, `notes` under it. */
  | { done: string; detail?: string; notes?: string[] }
  /** The label a starting step's spinner shows instead of its message ("" for none). */
  | { spin: string }
  /** A fact the end of the run shows (`Live`), `lead` ones first. */
  | { fact: Fact; lead?: boolean };

/** `running(step)`: that step has started and not finished. */
type Milestone = (
  event: StepEvent,
  running: (step: string) => boolean,
) => Shown | Shown[] | null;

/** The milestones: the steps a person sees, by name, and how. */
const MILESTONES: Readonly<Record<string, Milestone>> =
  {
    "setup.account": (event) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      const email = text(data["email"]);
      return {
        line: `Setting up Every App in ${text(data["name"]) ?? text(data["id"])}${email ? chalk.dim(` (${email})`) : ""}`,
      };
    },
    "setup.gateway": (event) => {
      const data = event.data ?? {};
      const release = text(data["release"]);
      const from = text(data["from"]);
      if (event.status === "start") {
        if (!from) {
          const host = text(data["gatewayUrl"])?.replace(/^https:\/\//, "");
          return { line: `Installing Gateway ${release} at ${host}` };
        }
        if (from !== release) return { line: `Upgrading the Gateway ${from} → ${release}` };
        // setup's repair of a Gateway that runs this release already.
        if (data["redeploy"] === true) return { line: `Redeploying the Gateway ${release}` };
        const apps = Number(data["apps"] ?? 0);
        const was = Number(data["was"] ?? apps);
        return {
          line: `Gateway ${release} up to date · binding ${plural(apps, "app")}${was !== apps ? ` (was ${was})` : ""}`,
        };
      }
      if (event.status !== "skip") return null;
      if (data["upToDate"] === true) {
        return {
          line: `Gateway ${release} at ${text(data["gatewayUrl"])} is up to date.`,
        };
      }
      return event.message ? { line: event.message } : null;
    },
    "setup.owner": (event) => {
      if (event.status !== "ok") return null;
      const email = text(event.data?.["email"]);
      return email ? { done: `Owner account created for ${email}` } : null;
    },
    // Setup shows the Gateway's database and upload. Elsewhere (binding an
    // app, a delete, a Gateway setting) it is one step's work, shown only
    // when its migrations ran.
    "gateway.migrations": (event, running) => {
      const inSetup = running("setup.gateway");
      if (event.status === "start") return inSetup ? null : { spin: "" };
      if (!inSetup && strings(event.data?.["applied"]).length === 0) return null;
      return migrated(event, inSetup ? "Database" : "Gateway database");
    },
    "gateway.deploy": (event, running) => {
      if (event.status === "start") {
        return {
          spin: running("setup.gateway")
            ? "Uploading..."
            : running("app.bind")
              ? ""
              : "Updating the Gateway...",
        };
      }
      return event.status === "ok" && running("setup.gateway") ? { done: "Uploaded" } : null;
    },
    "gateway.reconcile": (event) =>
      event.status === "skip" && event.message ? { line: event.message } : null,
    "app.register": (event) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      const appId = text(data["appId"]) ?? "The app";
      const organization = text(data["organizationName"]);
      const secrets = strings(data["secrets"]);
      const unset = strings(data["unsetSecrets"]);
      const isNew = data["existingApp"] === false;
      const first = {
        line:
          secrets.length || unset.length
            ? `${isNew ? "Deploying" : "Redeploying"} ${appId} ${secrets.length ? `with ${secrets.join(", ")}` : `without ${unset.join(", ")}`} (code and pending migrations from this directory)`
            : `Deploying ${appId}${organization ? ` to ${organization}` : ""}${isNew ? chalk.dim(" (first deploy)") : ""}`,
      };
      if (!isNew) return first;
      const admin = text(data["gatewayUrl"]);
      const change = chalk.dim(
        `· change it ${admin ? `at ${admin}/admin/apps` : "in Admin → Apps"}`,
      );
      const access =
        data["scope"] === "shared"
          ? `Members of every organization ${chalk.dim("(shared app)")}`
          : data["defaultAccess"] === true
            ? `Everyone${organization ? ` in ${organization}` : ""} ${change}`
            : data["deployerAccess"] === false
              ? `Private to owners and admins ${change}`
              : `Private to you, owners and admins ${change}`;
      return [first, { fact: { label: "Access", value: access } }];
    },
    "app.install": (event) =>
      event.status === "ok" ? { done: "Installed dependencies" } : null,
    "app.build": (event) => (event.status === "ok" ? { done: "Built" } : null),
    "app.migrations": (event) => migrated(event, "Database"),
    "app.upload": (event) => {
      if (event.status === "start") return { spin: "Uploading..." };
      return event.status === "ok" ? { done: "Uploaded" } : null;
    },
    "app.lease": (event) =>
      event.status === "ok" ? { done: "Other deploy finished" } : null,
    "app.email": (event) => {
      if (event.status === "skip" && event.message) return { line: event.message };
      if (event.status !== "ok") return null;
      const addresses = strings(event.data?.["addresses"]);
      return {
        done: addresses.length
          ? `Mail to ${addresses.join(", ")} routed`
          : "Mail routes removed",
      };
    },
    "app.bind": (event) =>
      event.status === "start"
        ? { spin: "Adding to the Gateway..." }
        : event.status === "ok"
          ? { done: "Added to the Gateway" }
          : null,
    "app.live": (event) => {
      if (event.status === "skip" && event.message) return { line: event.message };
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      const url = text(data["url"]) ?? `https://${text(data["hostname"])}`;
      return { fact: { label: "Live", value: chalk.cyan(url) }, lead: true };
    },
    "app.delete": (event) =>
      event.status === "ok"
        ? {
            line: `Removed ${text(event.data?.["appId"]) ?? "the app"} from the Gateway`,
          }
        : null,
    "create.copy": (event) => {
      const data = event.data ?? {};
      if (event.status === "start") {
        return { line: `Creating ${text(data["appId"])} in ${text(data["shown"])}` };
      }
      return event.status === "ok" ? { done: "Copied the starter template" } : null;
    },
    "create.skill": (event) =>
      event.status === "ok" ? { done: "Added the everyapp skill for coding agents" } : null,
    "create.install": (event) =>
      event.status === "ok" ? { done: "Installed dependencies" } : null,
    "create.types": (event) =>
      event.status === "ok" ? { done: "Generated types" } : null,
    "dev.types": (event) =>
      event.status === "ok"
        ? { done: "Worker types generated", detail: ".cloudflare/types" }
        : null,
    "dev.migrations": (event) => {
      if (event.status === "skip") {
        return event.data?.["reason"] === "flag"
          ? { line: chalk.dim("Skipped local migrations (--skip-migrations)") }
          : null;
      }
      if (event.status !== "ok") return null;
      const applied = strings(event.data?.["applied"]);
      return {
        done: applied.length
          ? `${plural(applied.length, "local migration")} applied`
          : "Local database up to date",
      };
    },
    // The ready line, then the block of how to reach the app.
    "dev.app": (event) =>
      event.status === "ok"
        ? [
            { done: `${text(event.data?.["appId"]) ?? "The app"} is running locally` },
            ...(event.message ? [{ line: event.message }] : []),
          ]
        : null,
    "dev.stop": (event) => {
      const appId = text(event.data?.["appId"]) ?? "the app";
      return event.data?.["started"] === true
        ? { done: `${appId} stopped` }
        : { line: chalk.dim(`Stopped before ${appId} started.`) };
    },
    "migrations.local": (event) => {
      if (event.status === "skip" && event.message)
        return { line: event.message };
      if (event.status !== "ok") return null;
      const applied = strings(event.data?.["applied"]);
      return applied.length
        ? { done: "Local database migrated", detail: plural(applied.length, "migration") }
        : { done: "Local database up to date" };
    },
    "cloudflare.login": (event) => {
      const data = event.data ?? {};
      const who = text(data["email"]);
      const as = who ? ` as ${who}` : data["token"] === true ? " with CLOUDFLARE_API_TOKEN" : "";
      if (event.status === "skip") return { line: `Already logged in to Cloudflare${as}` };
      return event.status === "ok" ? { done: `Logged in to Cloudflare${as}` } : null;
    },
    "db.migrate": (event) => {
      if (event.status === "start") return { spin: "Applying migrations to the local database..." };
      if (event.status === "skip" && event.message) return { line: chalk.dim(event.message) };
      if (event.status !== "ok") return null;
      const applied = strings(event.data?.["applied"]);
      return applied.length
        ? {
            done: `${plural(applied.length, "migration")} applied to the local database`,
            detail: "",
            notes: applied,
          }
        : { done: "Local database up to date", detail: "" };
    },
    "db.query": (event) =>
      event.status === "start"
        ? { spin: `Querying the ${text(event.data?.["database"])} database...` }
        : null,
    "db.restore": (event) => {
      if (event.status === "start") return { spin: "Restoring..." };
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      const appId = text(data["appId"]);
      return {
        done: `Restored ${appId ? `${appId}'s` : "the Gateway's"} database`,
        detail: `before ${strings(data["migrations"]).join(", ")}`,
      };
    },
  };

/**
 * Warnings a person sees only with --verbose: nothing can be done about
 * them (other Workers' Custom Domains can't be listed, so whether one serves
 * a new hostname is unknown until cf, attached with --verbose, asks).
 */
const QUIET_WARNINGS = new Set(["CUSTOM_DOMAIN_OWNER_UNCHECKED"]);

const always = () => true;
/**
 * The certificate wait, not each certificate as it comes (`data.host`):
 * the next line says the gateway is live.
 */
const waiting = (data: EventData) => data["host"] === undefined;

/**
 * Progress a person sees without --verbose, by step: the waits (a lease,
 * a deploy `db restore` waits out, an app going live with its certificate,
 * the gateway's certificates) and
 * the Gateway build.
 */
const SHOWN_PROGRESS: Readonly<Record<string, (data: EventData) => boolean>> = {
  "app.lease": always,
  "gateway.lease": always,
  "db.lease": always,
  "gateway.release": always,
  "app.live": always,
  "gateway.tls": waiting,
};

/**
 * Progress a person sees as it comes, a dim line each, like request logs:
 * `everyapp dev`'s tool calls and how to use the running app.
 */
const LOGGED_PROGRESS = new Set(["dev.mcp", "dev.session"]);

/**
 * A migration step: a database that was empty is created, one that had
 * migrations names those this run applied, with how to restore it.
 */
function migrated(event: StepEvent, what: string): Shown | null {
  if (event.status !== "ok") return null;
  const data = event.data ?? {};
  const applied = strings(data["applied"]);
  if (applied.length === 0) return { done: `${what} up to date` };
  if (data["fresh"] === true) {
    return { done: `${what} created`, detail: plural(applied.length, "migration") };
  }
  const restore = text(data["restoreCommand"]);
  return {
    done: `${what} migrated`,
    detail: applied.join(", "),
    notes: restore ? [`Restore point saved. To undo: ${restore}`] : [],
  };
}

/** A problem: its first line after the glyph, the rest dim under it, then `data.fix`. */
function headed(glyph: string, message: string): string[] {
  const [headline = "", ...detail] = message.split("\n");
  return [
    `${glyph} ${headline}`,
    ...detail.map((line) => chalk.dim(`  ${line}`)),
  ];
}

/** What to do about a problem: `data.fix`, then the command to run next. */
function nextCommand(data: EventData | undefined, label: string): string[] {
  const fix = text(data?.["fix"]);
  const rerun = text(data?.["rerun"]);
  return [
    ...(fix ? [`  Fix: ${fix}`] : []),
    ...(rerun
      ? [
          data?.["authorize"] === true
            ? `  To go ahead anyway: ${chalk.bold(rerun)}`
            : `  ${label}: ${chalk.bold(rerun)}`,
        ]
      : []),
  ];
}

/** A labelled value in the block that ends a run (`Live  https://…`). */
interface Fact {
  label: string;
  value: string;
}

/** Facts a `done` event carries itself (`data.facts`), each `{ label, value, note? }`. */
function factsIn(value: unknown): Fact[] {
  if (!Array.isArray(value)) return [];
  return value.map((fact: { label: string; value: string; note?: string }) => ({
    label: fact.label,
    value: `${/^https?:\/\//.test(fact.value) ? chalk.cyan(fact.value) : fact.value}${fact.note ? `  ${chalk.dim(fact.note)}` : ""}`,
  }));
}

/** `data.next`: commands, each as a string or `{ command, note }`. */
function nextItems(value: unknown): Array<{ command: string; note?: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item: string | { command: string; note?: string }) =>
    typeof item === "string" ? { command: item } : item,
  );
}

function formatNext(items: Array<{ command: string; note?: string }>): string[] {
  const width = Math.max(...items.map((item) => item.command.length));
  return items.map((item) =>
    item.note
      ? `  ${item.command.padEnd(width)}  ${chalk.dim(item.note)}`
      : `  ${item.command}`,
  );
}

/** "850ms" is never shown; "4.2s", "41s", "1m 4s". */
function duration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

/**
 * stdout for a person: lines and, at a terminal, the spinner of the step
 * running on the line after them, with the cursor hidden. Piped, nothing
 * spins.
 */
class Screen {
  /** Steps started and not finished, innermost last: the spinner shows the innermost label. */
  private steps: Array<{ step: string; label: string; since: number }> = [];
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  /** The terminal's current line holds our drawing. */
  private drawn = false;

  constructor(
    private readonly write: (text: string) => void,
    private readonly terminal: boolean,
    private readonly columns: () => number,
    private readonly now: () => number,
  ) {}

  lines(text: string): void {
    this.erase();
    this.write(`${text}\n`);
    this.draw();
  }

  /** `step` runs; a step already running keeps its place and start, with `label`. */
  spin(step: string, label: string): void {
    const current = this.steps.find((run) => run.step === step);
    if (current) current.label = label;
    else this.steps.push({ step, label, since: this.now() });
    if (!this.terminal) return;
    if (!this.timer) {
      cliCursor.hide(process.stdout);
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
    const index = this.steps.findIndex((run) => run.step === step);
    if (index < 0) return;
    this.steps = this.steps.slice(0, index);
    this.settle();
  }

  /** `step` alone stopped (a wait), not what started after it. */
  drop(step: string): void {
    this.steps = this.steps.filter((run) => run.step !== step);
    this.settle();
  }

  /** Something writes to the terminal beside us (stderr): nothing of ours on its line meanwhile. */
  aside(writeIt: () => void): void {
    if (this.terminal) this.erase();
    writeIt();
    this.draw();
  }

  /** A prompt or an attached child takes the terminal: stop the spinner. */
  handOver(): void {
    this.steps = [];
    this.stopTimer();
    this.erase();
  }

  /** The run's last word comes next. */
  finish(): void {
    this.handOver();
  }

  private settle(): void {
    if (this.steps.length === 0) this.stopTimer();
    this.draw();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    cliCursor.show(process.stdout);
  }

  private erase(): void {
    if (!this.drawn) return;
    this.write("\r\x1b[2K");
    this.drawn = false;
  }

  /** At a terminal: the innermost labelled step, how long it has run past 5s, then the spinner. */
  private draw(): void {
    if (!this.terminal) return;
    const run = this.steps.findLast((step) => step.label) ?? this.steps.at(-1);
    if (!run) {
      this.erase();
      return;
    }
    const took = this.now() - run.since;
    const spinner = `${run.label ? `${run.label} ` : ""}${took >= 5000 ? `· ${duration(took)} ` : ""}${FRAMES[this.frame]}`;
    const width = Math.max(this.columns() - 1, 10);
    this.write(
      `\r\x1b[2K${chalk.dim(
        spinner.length > width
          ? `…${spinner.slice(spinner.length - width + 1)}`
          : spinner,
      )}`,
    );
    this.drawn = true;
  }
}

function trackExitCode(
  write: (event: EventInput<EveryAppEvent>) => void,
  verbose: boolean,
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
    verbose,
  };
}
