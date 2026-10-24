/**
 * Progress events for commands that agents and scripts drive.
 *
 * With `--json`, stdout carries only these events, one JSON object per line
 * (NDJSON), each `{ v: 1, ts, type, … }`. People see a filter over the same
 * events instead (createHumanSink). A run ends with exit code 0 when done, 2
 * when it stopped on `action_required` (re-run the same command to resume
 * once the action is taken), and 1 after an error, whatever came before it.
 * An error says what to do next its own way (lib/errors.ts): `data.fix`, a
 * remedy in words, and `data.rerun`, the command to run (with
 * `data.rerunNote`), where one helps, and `data.url`, a page to open; an
 * action always has `data.rerun`, or `data.choices` when the way on is one
 * of several commands (each `{ rerun, label }`). An
 * error whose rerun takes something over (a flag like --force-dns) has
 * `data.authorize: true`: show it and ask before running it. An error with
 * code CANCELLED is a person declining a prompt. A warning is emitted once
 * per run, however often it is raised, and `done` carries the run's
 * `data.durationMs`.
 *
 * An `action_required` with `data.waiting: true` is one the run waits for
 * (a login to approve, a setup link to open): pass its `url` and `code` to
 * a person and keep reading. If it is taken in time the run goes on and
 * ends `done` (exit 0), or with an error (exit 1) like any run; if not, a
 * last `action_required` ends it (exit 2).
 */
import chalk from "chalk";
import cliCursor from "cli-cursor";
import { listPublicRoutes, type PublicRouteSummary } from "@/lib/app/publicRoutes";
import { ReportCode } from "@/lib/errors";
import { GatewayChange } from "@/lib/gateway/change";
import { onInterruptNotice } from "@/lib/interrupt";
import { CLI } from "./command";
import { formatFacts, type Fact } from "./table";
import { capitalize, listed, plural, strings, text } from "./text";
import { duration, roughly } from "./time";
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
  /** Only a person at a terminal can do the rerun: an agent hands it on instead of running it. */
  needsTerminal?: boolean;
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
  const sink = emitter(
    (event) => {
      // `display` is drawn for a person; a script reads `data`.
      const line = event.type === "done" ? { ...event, display: undefined } : event;
      write(`${JSON.stringify({ v: 1, ts: now().toISOString(), ...line })}\n`);
    },
    false,
    () => now().getTime(),
  );
  onInterruptNotice({
    stopping: (message) => sink.emit({ type: "progress", step: "interrupt", message }),
    stopped: () => undefined,
  });
  return sink;
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
 *  - `warning`, `action_required`, `error` and `done`: always. Each problem
 *    is a one-line headline, its detail dim under it, then what to do:
 *    `data.fix`, then the command to run (`data.rerun`, `data.rerunNote`
 *    dim after it). With --verbose an error adds its code, and an
 *    unexpected one its stack. A CANCELLED error is only its message, dim.
 *    Problems go to stderr. `done` ends with the facts, the run's time when
 *    it took 10 seconds or more, and `data.next`.
 *  - Piped, a step that runs long says so every 30 seconds (`still
 *    building the Gateway · 1m`), so a CI log shows it's alive.
 *  - Ctrl-C (lib/interrupt.ts): the spinner becomes the line saying what's
 *    being stopped, and the last line says it stopped.
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
  onInterruptNotice({
    stopping: (message) => screen.interrupt(`${message} (Ctrl+C again to quit at once)`),
    stopped: (closing) => {
      screen.finish();
      if (closing) writeProblem(`${chalk.dim(closing)}\n`);
    },
  });
  const problem = (lines: string[]) =>
    screen.aside(() => writeProblem(`${lines.join("\n")}\n`));
  // When each running step started, for the time its ticked line shows.
  const started = new Map<string, number>();
  // Waits drawn as a spinner (or, piped, said once); each ends at the next step.
  const waits = new Set<string>();
  // The run's facts, shown together once it is done: `lead` ones first, in order.
  const facts: Fact[] = [];
  // Warnings shown, for the run's last line.
  let warned = 0;
  let leads = 0;

  const show = (items: readonly Shown[], took?: number) => {
    for (const item of items) {
      if ("line" in item) screen.lines(item.line);
      else if ("fact" in item) facts.splice(item.lead ? leads++ : facts.length, 0, item.fact);
      else if ("done" in item) {
        const after =
          item.detail ?? (took !== undefined && took >= 1000 ? duration(took) : "");
        screen.lines(
          [
            ticked(item.done, after),
            ...(item.notes ?? []).map((note) => chalk.dim(`  ${note}`)),
          ].join("\n"),
        );
      }
    }
  };

  return emitter((event) => {
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
        if (QUIET_WARNINGS.has(event.code) && !verbose) return;
        warned += 1;
        problem([
          ...headed(chalk.yellow("!"), event.message),
          ...nextCommand(event.data, { url: true }),
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
        writeProblem(
          `${[...lines, ...choiceLines(event.data?.["choices"]), ...nextCommand(event.data)].join("\n")}\n`,
        );
        return;
      }
      case "error": {
        screen.finish();
        if (event.code === ReportCode.Cancelled) {
          writeProblem(`${chalk.dim(event.message)}\n`);
          return;
        }
        const stack = verbose ? text(event.data?.["stack"]) : undefined;
        writeProblem(
          `${[
            ...headed(chalk.red("✗"), event.message),
            ...nextCommand(event.data, { url: true }),
            // Its frames only: the message is the headline already.
            ...(stack
              ? stack
                  .split("\n")
                  .filter((line) => /^\s+at /.test(line))
                  .map((line) => chalk.dim(`  ${line.trim()}`))
              : []),
            ...(verbose ? [chalk.dim(`  Error code: ${event.code}`)] : []),
          ].join("\n")}\n`,
        );
        return;
      }
      case "done": {
        screen.finish();
        const took = now() - began;
        const allFacts = [...facts, ...factsIn(event.data?.["facts"])];
        const next = nextItems(event.data?.["next"]);
        const lines = [
          // An empty `display`: the steps said it all.
          ...(event.display !== undefined
            ? event.display
              ? [event.display]
              : []
            : event.message
              ? [chalk.green(event.message)]
              : []),
          ...(allFacts.length > 0 ? ["", ...formatFacts(allFacts)] : []),
          ...(took >= 10_000 && event.display === undefined
            ? [chalk.dim(`Done in ${duration(took)}${warned > 0 ? ` with ${plural(warned, "warning")}` : ""}`)]
            : []),
          ...(next.length > 0 ? ["", "Next:", ...formatNext(next)] : []),
        ];
        if (lines.length > 0) screen.lines(lines.join("\n"));
        return;
      }
    }
  }, verbose, now);
}

/** Something done, as a ticked line: `Built ✓ 4.2s`, `after` dim. */
export function ticked(done: string, after?: string): string {
  return `${done} ${chalk.green("✓")}${after ? ` ${chalk.dim(after)}` : ""}`;
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

/** A milestone shown only once its step is done: a ticked line, `detail` (else its time) after it. */
function doneWhenOk(done: string, detail?: string): Milestone {
  return (event) => (event.status === "ok" ? { done, detail } : null);
}

/** A step with a spinner while it runs, then a ticked line (its time after it). */
function spinThenDone(spin: string, done: string): Milestone {
  return (event) => (event.status === "start" ? { spin } : event.status === "ok" ? { done } : null);
}

/** A step its own messages say: its start's as the spinner's label, its ok's as the ticked line. */
function saidByMessage(event: StepEvent): Shown | null {
  if (event.status === "start") return { spin: event.message ?? "" };
  return event.status === "ok" && event.message ? { done: event.message } : null;
}

/** The milestones: the steps a person sees, by name, and how. */
const MILESTONES: Readonly<Record<string, Milestone>> =
  {
    "setup.account": (event) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      // A live Gateway's own line names the account.
      if (data["gateway"] === true) return null;
      const email = text(data["email"]);
      return {
        line: `Setting up Every App in ${text(data["name"]) ?? text(data["id"])}${email ? chalk.dim(` (${email})`) : ""}`,
      };
    },
    "setup.gateway": (event) => {
      const data = event.data ?? {};
      // Its version, or its commit when the version doesn't say what it is.
      const name = text(data["releaseName"]);
      const account = text(data["account"]);
      // "Ben Senescu's Gateway", or "the Gateway".
      const theirs = account ? `${account}'s Gateway` : "the Gateway";
      if (event.status === "start") {
        const host = text(data["gatewayUrl"])?.replace(/^https:\/\//, "");
        switch (data["change"]) {
          case GatewayChange.Install:
            return { line: `Installing the Gateway at ${host} (${name})` };
          case GatewayChange.Resume:
            return { line: `Resuming the Gateway install at ${host} (${name})` };
          case GatewayChange.Upgrade:
            return { line: `Upgrading ${theirs} to ${name}` };
          case GatewayChange.Repair:
            return { line: `Repairing ${theirs} (${name})` };
          case GatewayChange.Redeploy:
            return { line: `Redeploying ${theirs} (${name})` };
          default:
            return null;
        }
      }
      if (event.status === "ok" && data["repaired"] === true) {
        const added = strings(data["added"]);
        if (added.length > 0) return { done: `Gateway now routes ${added.join(", ")}` };
        const apps = Number(data["apps"] ?? 0);
        const was = Number(data["was"] ?? apps);
        return {
          done: `Gateway routes ${plural(apps, "app")}`,
          detail: was !== apps ? `was ${was}` : "",
        };
      }
      if (event.status !== "skip") return null;
      if (data["upToDate"] === true) {
        return { done: `${capitalize(theirs)} is up to date with ${name}`, detail: "" };
      }
      return event.message ? { line: event.message } : null;
    },
    "setup.owner": (event) => {
      const email = text(event.data?.["email"]);
      if (!email) return null;
      if (event.status === "skip") return { done: `Owner account is ${email}`, detail: "" };
      return event.status === "ok" ? { done: `Owner account created for ${email}` } : null;
    },
    // Setup shows the Gateway's database and upload. Elsewhere (binding an
    // app, a delete, a Gateway setting) it is one step's work, shown only
    // when its migrations ran.
    "gateway.migrations": (event, running) => {
      const inSetup = running("setup.gateway");
      const upgrade = running("gateway.upgrade");
      if (event.status === "start") return inSetup ? null : { spin: "" };
      if (!inSetup && !upgrade && strings(event.data?.["applied"]).length === 0) return null;
      const shown = migrated(event, inSetup || upgrade ? "Database" : "Gateway database");
      return upgrade ? under(shown) : shown;
    },
    "gateway.deploy": (event, running) => {
      if (event.status === "start") {
        return {
          spin: running("setup.gateway")
            ? "Uploading..."
            : running("app.bind") || running("app.delete")
              ? ""
              : "Updating the Gateway...",
        };
      }
      if (event.status !== "ok") return null;
      if (running("gateway.upgrade")) return under({ done: "Uploaded" });
      return running("setup.gateway") ? { done: "Uploaded" } : null;
    },
    "gateway.reconcile": (event) =>
      event.status === "skip" && event.message ? { line: event.message } : null,
    // A deploy's first line: what goes to which Gateway, and whose it is.
    "app.deploy": (event) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      const version = text(data["version"]);
      const organization = text(data["organizationName"]);
      const origin = text(data["origin"]);
      return {
        line: [
          `Deploying ${text(data["appId"])}${version ? ` ${version}` : ""} to ${text(data["gatewayHost"])}${organization ? chalk.dim(` (${organization})`) : ""}`,
          ...(origin ? [chalk.dim(`  From ${origin}`)] : []),
        ].join("\n"),
      };
    },
    // `register`'s own header; for a deploy, who can open an app that has
    // never been live, and what its manifest opens to anyone on the
    // internet (every deploy): facts for the end.
    "app.register": (event) => {
      const data = event.data ?? {};
      if (event.status !== "ok") return null;
      if (data["register"] === true) {
        const appId = text(data["appId"]) ?? "The app";
        const organization = text(data["organizationName"]);
        const header = { line: `Registering ${appId}${organization ? ` with ${organization}` : ""}` };
        if (data["existingApp"] !== false) return header;
        return [
          header,
          {
            done: `Registered ${appId} as a shared app`,
            detail: "open to every organization's members",
            notes: ["Its Worker needs the Gateway's identity keys, issuer, vars and binding props: see data.worker in --json"],
          },
        ];
      }
      const routes = publicRoutesIn(data["publicRoutes"]);
      const open: Shown[] =
        routes.length > 0 ? [{ fact: { label: "Public", value: publicValue(routes) } }] : [];
      if (data["firstDeploy"] !== true) return open.length > 0 ? open : null;
      const organization = text(data["organizationName"]);
      const change = chalk.dim(`· change it at ${text(data["gatewayUrl"])}/admin/apps`);
      const access =
        data["scope"] === "shared"
          ? `Members of every organization ${chalk.dim("(shared app)")}`
          : data["defaultAccess"] === true
            ? `Everyone${organization ? ` in ${organization}` : ""} ${change}`
            : data["deployerAccess"] === false
              ? `Private to owners and admins ${change}`
              : `Private to you, owners and admins ${change}`;
      const noOwner =
        data["hasOwner"] === false
          ? `\n  ${chalk.dim(`The Gateway has no owner yet; its first owner gets the app (${CLI} setup).`)}`
          : "";
      return [{ fact: { label: "Access", value: `${access}${noOwner}` } }, ...open];
    },
    "app.hyperdrive": (event) =>
      event.status === "ok"
        ? {
            done: "Connected to Postgres through Hyperdrive",
            notes:
              event.data?.["caching"] === "off"
                ? ['Query caching is off; caching: "default" in everyapp.config.ts turns it on.']
                : [],
          }
        : null,
    "app.install": doneWhenOk("Installed dependencies"),
    "app.build": (event) => {
      if (event.status === "start") return { spin: "Building..." };
      if (event.status !== "ok") return null;
      return { done: event.data?.["release"] === true ? "Release checked" : "Built" };
    },
    "app.schema": (event) => {
      if (event.status === "start") return { spin: "Checking the schema..." };
      if (event.status === "skip" && event.message) return { line: chalk.dim(event.message) };
      return event.status === "ok" ? { done: "Schema matches the migrations" } : null;
    },
    "app.migrations": (event) => {
      if (event.status === "start") {
        return {
          spin:
            event.data?.["dialect"] === "postgresql"
              ? "Migrating the Postgres database..."
              : "Migrating the database...",
        };
      }
      // drizzle-kit doesn't say which migrations it applied.
      if (event.status === "ok" && event.data?.["applied"] === undefined) {
        return { done: "Database migrated" };
      }
      return migrated(event, "Database");
    },
    "app.helper": (event) => {
      const name = text(event.data?.["name"]);
      if (event.status === "start") return { spin: `Uploading ${name}...` };
      return event.status === "ok" ? { done: `Uploaded helper Worker ${name}` } : null;
    },
    // `register` again: the Worker's newer version recorded (the first says Registered).
    "app.record": (event) => {
      const data = event.data ?? {};
      if (event.status !== "ok" || data["existingApp"] !== true) return null;
      const deployedAt = data["deployedAt"];
      return {
        done: "Recorded the Worker's current version",
        ...(typeof deployedAt === "number"
          ? { detail: `deployed ${roughly(Date.now() - deployedAt)} ago` }
          : {}),
      };
    },
    "app.upload": (event) => {
      if (event.status === "start") return { spin: "Uploading..." };
      if (event.status !== "ok") return null;
      // A hosted deploy's upload: what it carried.
      const data = event.data ?? {};
      return typeof data["modules"] === "number"
        ? {
            done: "Uploaded",
            detail: `${plural(data["modules"], "module")}, ${plural(Number(data["assets"]), "asset")}, ${plural(Number(data["migrations"]), "migration")}`,
          }
        : { done: "Uploaded" };
    },
    // `deploy --bundle-only`: the release it packed, and where.
    "app.release": (event) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      return [
        { done: `Packed ${text(data["appId"])} ${text(data["version"])}` },
        { fact: { label: "Release", value: text(data["shown"]) ?? "" } },
        { fact: { label: "SHA-256", value: (text(data["sha256"]) ?? "").slice(0, 12) } },
      ];
    },
    "app.workflows": (event) =>
      event.status === "ok"
        ? { done: `Deleted the Workflow ${text(event.data?.["binding"])}` }
        : null,
    // A hosted Gateway deploys the uploaded app itself.
    "app.hosted": (event) => {
      const data = event.data ?? {};
      const host = text(data["gatewayHost"]);
      if (event.status === "start") {
        return { spin: `Waiting for ${host} to deploy ${text(data["appId"])}` };
      }
      if (event.status === "ok") return { done: "Deployed" };
      if (event.status !== "skip") return null;
      return {
        done: `Handed to ${host}`,
        detail: `job ${text(data["jobId"])}`,
        notes: [`It deploys ${text(data["appId"])} on its own; this run didn't wait for it.`],
      };
    },
    "app.lease": leaseWaited,
    "gateway.lease": leaseWaited,
    "gateway.release": (event, running) => {
      if (event.status !== "ok") return null;
      const data = event.data ?? {};
      if (data["downloaded"] === true) return { done: `Downloaded Gateway ${text(data["release"])}` };
      const file = text((data["origin"] as { path?: unknown } | undefined)?.path);
      if (file) return { done: `Loaded Gateway ${text(data["release"])} from ${file}`, detail: "" };
      if (data["cached"] !== false) return null;
      return running("gateway.upgrade") ? under({ done: "Built" }) : { done: "Built from this checkout" };
    },
    "app.email": (event) => {
      const data = event.data ?? {};
      if (event.status === "start") {
        return { spin: data["removing"] === true ? "Removing mail routes..." : "Routing mail..." };
      }
      if (event.status !== "ok") return null;
      const addresses = strings(data["addresses"]);
      const replies = text(data["replyHint"]);
      return [
        ...strings(data["enabled"]).map((domain) => ({
          done: `Email Routing turned on for ${domain}`,
        })),
        addresses.length
          ? {
              done: `Mail to ${addresses.join(", ")} routed`,
              ...(replies ? { notes: [replies] } : {}),
            }
          : { done: "Mail routes removed" },
      ];
    },
    // After a deploy or a delete behind Cloudflare Access: shown only when
    // the public paths Access lets through changed.
    "app.access": (event) =>
      event.status === "ok"
        ? {
            done:
              event.data?.["removed"] === true
                ? `Cloudflare Access no longer lets ${text(event.data?.["appId"])}'s public routes through`
                : `Cloudflare Access lets ${text(event.data?.["appId"])}'s public routes through`,
          }
        : null,
    "app.bind": (event) =>
      event.status === "start"
        ? { spin: `Adding ${text(event.data?.["appId"])} to the Gateway...` }
        : event.status === "ok"
          ? { done: "Added to the Gateway" }
          : null,
    // Adding an app upgrades the Gateway: its steps go under this heading.
    "gateway.upgrade": (event) =>
      event.status === "start"
        ? {
            line: chalk.bold(`Gateway ${text(event.data?.["from"])} → ${text(event.data?.["to"])}`),
          }
        : null,
    "app.live": (event) => {
      const data = event.data ?? {};
      const url = text(data["url"]) ?? `https://${text(data["hostname"])}`;
      if (event.status === "skip") return notLiveYet(data, url);
      if (event.status !== "ok") return null;
      const live = { fact: { label: "Live", value: chalk.cyan(url) }, lead: true };
      // The wait it took, when there was one.
      const waited = text(data["waited"]);
      if (!waited) return live;
      return [{ done: waited === "certificate" ? "Certificate issued" : "Live" }, live];
    },
    "app.delete": (event) => {
      const appId = text(event.data?.["appId"]);
      if (event.status === "start") return { spin: `Removing ${appId} from the Gateway...` };
      if (event.status !== "ok") return null;
      return event.data?.["alreadyDeleted"] === true
        ? { line: `${appId} was already removed from the Gateway` }
        : { done: `Removed ${appId} from the Gateway` };
    },
    "app.certificate": (event) =>
      event.status === "ok"
        ? { done: `Removed ${text(event.data?.["hostname"])}'s certificate` }
        : null,
    "app.purge": (event) => {
      const appId = text(event.data?.["appId"]);
      if (event.status === "start") return { spin: `Deleting ${appId}'s Worker and data...` };
      if (event.status !== "ok") return null;
      const kinds = strings(event.data?.["kinds"]);
      return kinds.length > 0
        ? { done: `Deleted ${appId}'s ${listed(kinds)}` }
        : { line: chalk.dim(`Nothing of ${appId}'s was left to delete in Cloudflare`) };
    },
    "create.copy": (event) => {
      const data = event.data ?? {};
      if (event.status === "start") {
        return [
          { line: `Creating ${text(data["appId"])} in ${text(data["shown"])}` },
          // Run from somewhere in the checkout but its root.
          ...(data["elsewhere"] === true
            ? [{ line: chalk.dim("New apps go in the checkout's apps/ folder, wherever you run create.") }]
            : []),
        ];
      }
      return event.status === "ok" ? { done: "Copied the starter template" } : null;
    },
    // Inside `access on|off`, the settings are one line of that command's own summary.
    "secrets.gateway": (event, running) =>
      running("access.update") || running("access.off") ? null : saidByMessage(event),
    "secrets.app": saidByMessage,
    "create.skill": doneWhenOk("Added the everyapp skill for coding agents"),
    "create.install": spinThenDone("Installing dependencies...", "Installed dependencies"),
    "create.types": spinThenDone("Generating types...", "Generated types"),
    "create.git": (event) =>
      event.status === "start"
        ? { spin: "Starting a git repository..." }
        : event.status === "ok"
          ? { done: "Started a git repository", detail: "first commit: Starter template" }
          : null,
    // The app is made; what follows (a deploy) is a block of its own.
    "create.done": (event) => (event.status === "ok" ? { line: "" } : null),
    "dev.types": doneWhenOk("Worker types generated", ".cloudflare/types"),
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
      if (event.status === "start") return { spin: "Setting up the local database..." };
      if (event.status === "skip" && event.message)
        return { line: event.message };
      if (event.status !== "ok") return null;
      const applied = strings(event.data?.["applied"]);
      return {
        done: "Set up the local database",
        ...(applied.length ? { detail: plural(applied.length, "migration") } : {}),
      };
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

/** A lease came free after a wait (lib/gateway/lease.ts): "Other deploy finished ✓ 41s". */
function leaseWaited(event: StepEvent): Shown | null {
  return event.status === "ok"
    ? { done: `Other ${text(event.data?.["waitedFor"]) ?? "run"} finished` }
    : null;
}

const always = () => true;
/**
 * The certificate wait, not each certificate as it comes (`data.host`):
 * the next line says the gateway is live.
 */
const waiting = (data: EventData) => data["host"] === undefined;

/**
 * Progress a person sees without --verbose, by step: the waits (a lease,
 * a deploy `db restore` waits out, an app going live with its certificate,
 * the gateway's certificates).
 */
const SHOWN_PROGRESS: Readonly<Record<string, (data: EventData) => boolean>> = {
  "app.release": always,
  "app.lease": always,
  "gateway.lease": always,
  "db.lease": always,
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

/** A ticked line indented under a heading (`Gateway 0.2.0 → 0.2.1`), its notes too. */
function under(shown: Shown | null): Shown | null {
  if (!shown || !("done" in shown)) return shown;
  return {
    ...shown,
    done: `  ${shown.done}`,
    ...(shown.notes ? { notes: shown.notes.map((note) => `  ${note}`) } : {}),
  };
}

/**
 * What the end of a deploy says of an app that isn't live yet
 * (`data.reason`): its URL and when it goes live, or that nothing routes
 * to it.
 */
function notLiveYet(data: EventData, url: string): Shown[] {
  if (data["reason"] === "outside-base") {
    return [{ fact: { label: "Live", value: chalk.yellow("Not routed") }, lead: true }];
  }
  const status =
    data["reason"] === "certificate"
      ? "Goes live on its first visit, once its certificate comes (a few minutes)"
      : data["reason"] === "first-visit"
        ? "Goes live on its first visit"
        : undefined;
  return [
    { fact: { label: "URL", value: chalk.cyan(url) }, lead: true },
    ...(status ? [{ fact: { label: "Status", value: status }, lead: true }] : []),
  ];
}

/** A problem: its first line after the glyph, the rest dim under it, then `data.fix`. */
function headed(glyph: string, message: string): string[] {
  const [headline = "", ...detail] = message.split("\n");
  return [
    `${glyph} ${headline}`,
    ...detail.map((line) => chalk.dim(`  ${line}`)),
  ];
}

/**
 * What to do about a problem: a close match to what was typed
 * (`data.didYouMean`), how the command is used (`data.usage`), `data.fix`,
 * then the command to run next (`data.rerun`, else `data.help`), its note
 * dim after it.
 */
function nextCommand(
  data: EventData | undefined,
  /** Show `data.url` after the fix (an action shows it under its headline). */
  { url: withUrl = false }: { url?: boolean } = {},
): string[] {
  const didYouMean = text(data?.["didYouMean"]);
  const usage = text(data?.["usage"]);
  const fix = text(data?.["fix"]);
  const url = withUrl ? text(data?.["url"]) : undefined;
  const rerun = text(data?.["rerun"]) ?? text(data?.["help"]);
  const note = text(data?.["rerunNote"]);
  return [
    ...(didYouMean ? [`  Did you mean ${chalk.bold(didYouMean)}?`] : []),
    ...(usage ? [chalk.dim(`  Usage: ${usage}`)] : []),
    ...(fix ? [`  Fix: ${fix}`] : []),
    ...(url ? [`  ${chalk.cyan(url)}`] : []),
    ...(rerun
      ? [
          `  ${data?.["authorize"] === true ? "To go ahead anyway" : "Run"}: ${chalk.bold(rerun)}${note ? ` ${chalk.dim(note)}` : ""}`,
        ]
      : []),
  ];
}

/** An action's `data.choices`: the command for each, its label dim after it. */
function choiceLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const choices = value.map((choice: { rerun: string; label?: string | null }) => choice);
  const width = Math.max(...choices.map((choice) => choice.rerun.length));
  return choices.map(
    (choice) =>
      `  ${chalk.bold(choice.rerun.padEnd(width))}${choice.label ? `  ${chalk.dim(choice.label)}` : ""}`,
  );
}

/** Facts a `done` event carries itself (`data.facts`), each `{ label, value, note? }`. */
function factsIn(value: unknown): Fact[] {
  if (!Array.isArray(value)) return [];
  return value.map((fact: { label: string; value: string; note?: string }) => ({
    label: fact.label,
    value: `${/^https?:\/\//.test(fact.value) ? chalk.cyan(fact.value) : fact.value}${fact.note ? `  ${chalk.dim(fact.note)}` : ""}`,
  }));
}

/** A deploy's `data.publicRoutes`: `{ path, methods }` each. */
function publicRoutesIn(value: unknown): PublicRouteSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((route: PublicRouteSummary) => route);
}

/**
 * The Public fact: what the manifest opens to anyone on the internet,
 * `GET /hooks/*, POST /collect`, the first few, then how many more.
 */
function publicValue(routes: readonly PublicRouteSummary[]): string {
  const { shown, more } = listPublicRoutes(routes);
  return `Open to the internet without sign-in: ${shown}${
    more > 0 ? chalk.dim(` … and ${more} more (everyapp.config.ts public)`) : ""
  }`;
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


const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
/** How often, piped, a long step says it still runs. */
const STILL_MS = 30_000;

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
    if (!this.terminal) {
      this.keepAlive();
      return;
    }
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

  /** Ctrl-C: whatever ran stops showing, and `label` (what's being stopped) shows instead. */
  interrupt(label: string): void {
    this.handOver();
    if (this.terminal) this.spin("interrupt", label);
    else this.write(`${chalk.dim(label)}\n`);
  }

  private settle(): void {
    if (this.steps.length === 0) this.stopTimer();
    this.draw();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.terminal) cliCursor.show(process.stdout);
  }

  /**
   * Piped, nothing spins: every {@link STILL_MS} the innermost labelled
   * step that has run that long says it still runs, so a CI log moves.
   */
  private keepAlive(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const run = this.steps.findLast((step) => step.label);
      if (!run) return;
      const took = this.now() - run.since;
      if (took < STILL_MS) return;
      const label = run.label.replace(/\.{3}$|…$/, "");
      this.write(
        `${chalk.dim(`still ${label.charAt(0).toLowerCase()}${label.slice(1)} · ${roughly(took)}`)}\n`,
      );
    }, STILL_MS);
    this.timer.unref();
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

/**
 * What both sinks do with an event before writing it: a warning raised
 * again with the same words (a check run for the app, then for the
 * Gateway) is dropped; `done` gets the run's `durationMs`; and the exit
 * code is tracked.
 */
function emitter(
  write: (event: EventInput<EveryAppEvent>) => void,
  verbose: boolean,
  now: () => number,
): EventSink {
  const began = now();
  const warned = new Set<string>();
  let failed = false;
  let stopped = false;
  let waiting = false;
  return {
    emit(input) {
      let event = input;
      if (event.type === "warning") {
        const seen = `${event.code}\n${event.message}`;
        if (warned.has(seen)) return;
        warned.add(seen);
      } else if (event.type === "done") {
        event = { ...event, data: { ...event.data, durationMs: now() - began } };
      }
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
