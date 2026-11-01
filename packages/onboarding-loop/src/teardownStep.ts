/**
 * The wipe (design 4.2 step 2, section 5): `everyapp teardown` is the one
 * destructive path, run in the sibling container with the allowlist
 * derived for that child. First `--dry-run --json` (its plan is the
 * record's inventory; before a run the total must be 0), then
 * `--confirm <id> --json` with the id typed at /dev/tty when attended or
 * read from the confirm file Ben wrote once, then the dry run again every
 * 20 s for up to 3 minutes until nothing is left, then the zone's DNS must
 * show nothing at or under apps.<zone>. An in-account marker (a KV
 * namespace `every-loop-run-<runId>`) means another run may be using the
 * account. With what lock.ts knows (knownLocks): a run holding a live lock
 * here is refused unless forced; one whose lock died here (a SIGKILLed
 * driver, a stale lock gc swept) is stale whatever its age; one with no
 * lock here at all may be a run on another machine or under another
 * EVERYAPP_LOOP_HOME, so it is refused while younger than 2 hours. Without
 * a lock list the age rule decides alone. A stale marker goes with the
 * rest of the wipe. The run's own marker is never another run's.
 */
import fs from "node:fs";
import type { CfApi, DnsRecord } from "./cf";
import type { KnownLocks } from "./lock";
import type { Sibling } from "./withTestAccount";
import type { Account, CliEvent, Plan, PlanItem, PlanKind } from "./types";

const MARKER_PREFIX = "every-loop-run-";
const MARKER_FRESH_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 20_000;
const POLL_DEADLINE_MS = 3 * 60 * 1000;

type TeardownStepCode =
  | "marker_refused"
  | "cli_error"
  | "no_done"
  | "confirmation"
  | "leftovers"
  | "dns_leftovers";

export class TeardownStepError extends Error {
  constructor(
    readonly code: TeardownStepCode,
    message: string,
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = "TeardownStepError";
  }
}

interface TeardownStepOptions {
  sibling: Sibling;
  account: Account;
  runId: string;
  /** For the markers and the DNS check; null skips both, with a reason in the result. */
  cf: CfApi | null;
  /** How the account id is obtained for the real run: typed at /dev/tty, or the confirm file. */
  confirm: () => Promise<string>;
  /** Plan only: nothing is deleted. */
  dryRunOnly?: boolean;
  /** Ignore another run's marker (`pnpm loop teardown --account <name> --force`). */
  force?: boolean;
  /**
   * The runs this machine knows (lock.ts knownLocks): a marker of a live
   * one blocks, one of a dead one is stale whatever its age, one of a run
   * in neither list falls back to the 2-hour age rule. Absent, the age
   * rule decides alone.
   */
  locks?: KnownLocks;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  pollDeadlineMs?: number;
}

export interface TeardownStepResult {
  /** The inventory before anything was deleted. */
  before: Plan;
  /** The inventory after the re-poll; the same as `before` when nothing ran. */
  after: Plan;
  removed: string[];
  kept: unknown[];
  /** Dry-run polls after the deletion, 0 when nothing was deleted. */
  polls: number;
  dnsLeftovers: DnsRecord[];
  /** Markers found in the account (titles). */
  markers: string[];
  skipped: string[];
  events: CliEvent[];
}

/** The lines of a `--json` run that parse as the CLI's events. */
export function parseEvents(lines: string[]): CliEvent[] {
  const events: CliEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<CliEvent>;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.type === "string"
      )
        events.push(parsed as CliEvent);
    } catch {
      // Not JSON: a stray line from pnpm.
    }
  }
  return events;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const str = (value: unknown): string =>
  typeof value === "string" ? value : String(value ?? "");

/** The teardown's `data.plan` flattened to one item per thing it would delete. */
export function flattenPlan(data: unknown, at: string): Plan {
  const plan = asRecord(data);
  const items: PlanItem[] = [];
  const push = (kind: PlanKind, id: unknown, name: unknown): void => {
    items.push({ kind, id: id == null ? null : str(id), name: str(name) });
  };
  const access = asRecord(plan["access"]);
  for (const application of asArray(access["applications"])) {
    const row = asRecord(application);
    push("access", row["id"], `application "${str(row["name"])}"`);
  }
  if (access["policy"])
    push(
      "access",
      asRecord(access["policy"])["id"],
      `policy "${str(asRecord(access["policy"])["name"])}"`,
    );
  for (const zone of asArray(plan["email"])) {
    const row = asRecord(zone);
    for (const rule of asArray(row["rules"])) {
      const r = asRecord(rule);
      push(
        "email",
        r["id"],
        `rule for ${str(r["address"] ?? "(no address)")} on ${str(row["zoneName"])}`,
      );
    }
    if (row["catchAllWorker"])
      push("email", null, `catch-all of ${str(row["zoneName"])}`);
    if (row["disable"] === true)
      push("email", null, `Email Routing on ${str(row["zoneName"])}`);
  }
  for (const workflow of asArray(plan["workflows"]))
    push("workflows", null, workflow);
  for (const worker of asArray(plan["workers"]))
    push("workers", null, asRecord(worker)["name"]);
  for (const pack of asArray(plan["certificates"])) {
    const row = asRecord(pack);
    push("certificates", row["packId"], str(row["hostname"]));
  }
  for (const database of asArray(plan["d1"])) {
    const row = asRecord(database);
    push("d1", row["id"], row["name"]);
  }
  for (const namespace of asArray(plan["kv"])) {
    const row = asRecord(namespace);
    push("kv", row["id"], row["title"]);
  }
  for (const bucket of asArray(plan["r2"])) push("r2", null, bucket);
  for (const config of asArray(plan["hyperdrive"])) {
    const row = asRecord(config);
    push("hyperdrive", row["id"], row["name"]);
  }
  for (const name of asArray(plan["dns"])) {
    const row = asRecord(name);
    for (const record of asArray(row["records"])) {
      const r = asRecord(record);
      push("dns", r["id"], `${str(r["type"])} at ${str(row["name"])}`);
    }
  }
  const total =
    typeof plan["total"] === "number" ? plan["total"] : items.length;
  return {
    accountId: str(plan["accountId"]),
    items,
    total,
    kept: asArray(plan["kept"]).map(str),
    at,
  };
}

/** The `done` event of a teardown run, or the error it raised. */
function doneOf(
  events: CliEvent[],
  what: string,
): Extract<CliEvent, { type: "done" }> {
  const error = events.find((event) => event.type === "error");
  if (error && error.type === "error") {
    throw new TeardownStepError(
      "cli_error",
      `${what}: ${error.code}: ${error.message}`,
      error,
    );
  }
  const done = events.find((event) => event.type === "done");
  if (!done || done.type !== "done") {
    throw new TeardownStepError(
      "no_done",
      `${what} ended without a done event.`,
      events,
    );
  }
  return done;
}

/** The marker's title for a run. */
export const markerTitle = (runId: string): string =>
  `${MARKER_PREFIX}${runId}`;

/** The timestamp a runId starts with (2026-10-25T14:02-…), as a time, or null. */
export function runIdTime(runId: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(runId);
  if (!match) return null;
  const time = Date.parse(`${match[1]}:00Z`);
  return Number.isNaN(time) ? null : time;
}

/**
 * Another run's markers that may still be in use, never this run's own: a
 * run with a live lock here blocks at any age, one whose lock died here is
 * stale at any age, one this machine has no lock for (another machine's
 * run?) blocks while younger than 2 hours.
 */
export function blockingMarkers(
  titles: string[],
  runId: string,
  now: number,
  locks?: KnownLocks,
): string[] {
  return titles.filter((title) => {
    if (!title.startsWith(MARKER_PREFIX)) return false;
    const other = title.slice(MARKER_PREFIX.length);
    if (other === runId) return false;
    if (locks?.live.includes(other)) return true;
    if (locks?.dead.includes(other)) return false;
    const time = runIdTime(other);
    // A marker whose age can't be read is treated as young: refuse, say so.
    return time === null || now - time < MARKER_FRESH_MS;
  });
}

/** Puts this run's marker in the account; cleanup removes it (removeRunMarker), and the wipe would too (it is an `every-*` KV namespace). */
export async function createRunMarker(cf: CfApi, runId: string): Promise<void> {
  await cf.kvNamespaceCreate(markerTitle(runId));
}

/** Removes this run's own marker, by its exact title; true when one was there. */
export async function removeRunMarker(
  cf: CfApi,
  runId: string,
): Promise<boolean> {
  const title = markerTitle(runId);
  const own = (await cf.kvNamespacesList()).filter(
    (row) => row.title === title,
  );
  for (const row of own) await cf.kvNamespaceDelete(row.id);
  return own.length > 0;
}

/** The unattended confirmation: the file's content is `delete everything in <accountId>`. */
export function readConfirmFile(
  file: string,
  accountId: string,
): string | null {
  let text: string;
  try {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) !== 0) return null;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return text.trim() === `delete everything in ${accountId}` ? accountId : null;
}

/** The attended confirmation: the account id typed at /dev/tty (never y/N). */
export function confirmFromTty(accountId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      fd = fs.openSync("/dev/tty", "r+");
    } catch (error) {
      reject(
        new TeardownStepError(
          "confirmation",
          `No terminal to type ${accountId} at, and no confirm file.`,
          error,
        ),
      );
      return;
    }
    fs.writeSync(
      fd,
      `Type ${accountId} to delete everything EveryApp made in it: `,
    );
    const buffer = Buffer.alloc(256);
    const read = fs.readSync(fd, buffer, 0, buffer.length, null);
    fs.closeSync(fd);
    resolve(buffer.subarray(0, read).toString("utf8").trim().toLowerCase());
  });
}

/** Records at or under apps.<zone>: what a wipe must leave none of. */
export function recordsUnderGateway(
  records: DnsRecord[],
  zone: string,
): DnsRecord[] {
  const host = `apps.${zone}`.toLowerCase();
  return records.filter((record) => {
    const name = record.name.toLowerCase().replace(/\.$/, "");
    return name === host || name.endsWith(`.${host}`);
  });
}

export async function runTeardownStep(
  options: TeardownStepOptions,
): Promise<TeardownStepResult> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? POLL_MS;
  const pollDeadlineMs = options.pollDeadlineMs ?? POLL_DEADLINE_MS;
  const { account, sibling, runId } = options;
  const id = account.accountId;
  const skipped: string[] = [];
  const events: CliEvent[] = [];

  // 0. Another run's marker in the account.
  let markers: string[] = [];
  if (options.cf) {
    markers = (await options.cf.kvNamespacesList())
      .map((row) => row.title)
      .filter((t) => t.startsWith(MARKER_PREFIX));
    const blocking = blockingMarkers(markers, runId, now(), options.locks);
    if (blocking.length > 0 && !options.force) {
      const why = blocking.map((title) =>
        options.locks?.live.includes(title.slice(MARKER_PREFIX.length))
          ? `${title} still holds the lock here`
          : `${title} has no lock on this machine and is younger than 2 hours (a run elsewhere?)`,
      );
      throw new TeardownStepError(
        "marker_refused",
        `Another run left its marker in the account: ${why.join("; ")}; if that run is really gone, \`pnpm loop teardown --account ${account.name} --force\` wipes anyway.`,
        blocking,
      );
    }
  } else {
    skipped.push("markers: no Cloudflare API (dry run)");
  }

  // 1. The plan.
  const dryRun = async (what: string): Promise<Plan> => {
    const out = await sibling.everyapp([
      "teardown",
      "--account-id",
      id,
      "--dry-run",
      "--json",
    ]);
    const runEvents = parseEvents(out.stdout);
    events.push(...runEvents);
    if (runEvents.length === 0) {
      throw new TeardownStepError(
        "no_done",
        `${what} printed no events (exit ${out.result.exitCode}).`,
        out,
      );
    }
    const done = doneOf(runEvents, what);
    return flattenPlan(
      asRecord(done.data)["plan"],
      new Date(now()).toISOString(),
    );
  };
  const before = await dryRun("teardown --dry-run");

  let after = before;
  let removed: string[] = [];
  let kept: unknown[] = [];
  let polls = 0;

  if (before.total > 0 && !options.dryRunOnly) {
    // 2. The confirmation, from outside the allowlist mechanism.
    const typed = (await options.confirm()).trim().toLowerCase();
    if (typed !== id) {
      throw new TeardownStepError(
        "confirmation",
        `The confirmation does not match the account id. Nothing deleted.`,
      );
    }
    // 3. The deletion.
    const out = await sibling.everyapp([
      "teardown",
      "--account-id",
      id,
      "--confirm",
      typed,
      "--json",
    ]);
    const runEvents = parseEvents(out.stdout);
    events.push(...runEvents);
    const done = doneOf(runEvents, "teardown --confirm");
    const data = asRecord(done.data);
    removed = asArray(data["removed"]).map(str);
    kept = asArray(data["kept"]);
    // 4. Re-poll until nothing is left.
    const deadline = now() + pollDeadlineMs;
    after = await dryRun("teardown --dry-run (after)");
    polls = 1;
    while (after.total > 0 && now() < deadline) {
      await sleep(pollMs);
      after = await dryRun("teardown --dry-run (after)");
      polls += 1;
    }
    if (after.total > 0) {
      throw new TeardownStepError(
        "leftovers",
        `${after.total} resource(s) still in the account after ${polls} polls: ${after.items.map((item) => `${item.kind} ${item.name}`).join(", ")}`,
        after,
      );
    }
  } else if (options.dryRunOnly && before.total > 0) {
    skipped.push(`deletion: --dry-run (${before.total} resource(s) would go)`);
  }

  // 5. Nothing at or under apps.<zone>.
  let dnsLeftovers: DnsRecord[] = [];
  if (options.cf) {
    const zones = await options.cf.listZones(account.zone);
    const zone = zones.find(
      (row) => row.name.toLowerCase() === account.zone.toLowerCase(),
    );
    if (zone) {
      dnsLeftovers = recordsUnderGateway(
        await options.cf.dnsRecordsList(zone.id),
        account.zone,
      );
      if (dnsLeftovers.length > 0 && !options.dryRunOnly) {
        throw new TeardownStepError(
          "dns_leftovers",
          `${dnsLeftovers.length} DNS record(s) still at or under apps.${account.zone}: ${dnsLeftovers.map((r) => `${r.type} ${r.name}`).join(", ")}`,
          dnsLeftovers,
        );
      }
    } else {
      skipped.push(`dns: zone ${account.zone} not visible to the token`);
    }
  } else {
    skipped.push("dns: no Cloudflare API (dry run)");
  }

  return {
    before,
    after,
    removed,
    kept,
    polls,
    dnsLeftovers,
    markers,
    skipped,
    events,
  };
}
