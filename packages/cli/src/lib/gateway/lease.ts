/**
 * The deploy lease: a row in the gateway's own D1 that serializes
 * deploys. `gateway` covers the gateway (deploy, upgrade, reconcile), and
 * `app:<worker>` one app's migrations and upload. The CLI creates the table
 * itself (it isn't in the gateway's schema), in the same request that takes
 * the lease, so the lease exists before any migration runs.
 *
 * A row says who holds it for the people waiting on it: what the holder is
 * doing (`purpose`, a {@link LeasePurpose}), the app it locks (`app`), the
 * Cloudflare login running it (`deployer`) and the machine's name
 * (`machine`). `holder` itself (`host:pid:random`) only tells runs apart.
 *
 * A lease expires 3 minutes after its last renewal, and a heartbeat renews
 * it every 30 seconds, so a deploy that died frees it within 3 minutes. A
 * live deploy holds it as long as it runs (5-10 minutes is normal): the TTL
 * only decides how soon a dead holder is noticed. Nothing takes a live
 * lease over; `everyapp status` shows who holds one.
 *
 * With a TTL that short, a deploy must notice when the lease stops being
 * its own. A renewal that finds the row gone, or renewals that keep failing
 * for longer than half the TTL, lose it, and `check()` (called right before
 * migrating and before each `cf deploy`) renews it once more and stops the
 * deploy if it is lost. Renewals never overlap, and each one is given up
 * after 20 seconds rather than the runner's two minutes.
 *
 * A run waiting for a lease, and a heartbeat in trouble, say so through the
 * run's events on `step`: `progress` while it waits (the human sink redraws
 * it in place), `ok` once the other run finished, a `LEASE_HEARTBEAT`
 * warning when a renewal fails.
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import { loggedInAs } from "@/lib/cf/account";
import type { D1Database } from "@/lib/cf/d1";
import { CfTimeoutError } from "@/lib/cf/errors";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { onInterrupt } from "@/lib/interrupt";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { capitalize, textOrNull } from "@/lib/output/text";
import { roughly } from "@/lib/output/time";

/** What a lease's holder is doing. */
export enum LeasePurpose {
  AppDeploy = "app.deploy",
  AppRegister = "app.register",
  AppSecrets = "app.secrets",
  AppEmail = "app.email",
  GatewayDeploy = "gateway.deploy",
  GatewayUpgrade = "gateway.upgrade",
  GatewayReconcile = "gateway.reconcile",
  GatewaySecrets = "gateway.secrets",
  AccessSync = "access.sync",
  DbRestore = "db.restore",
}

/**
 * Each purpose as a person reads it: `noun` for "Other deploy finished",
 * `of` for "a deploy of todo" (`app` the app it locks, when the row has it).
 */
const PURPOSES: Readonly<
  Record<LeasePurpose, { noun: string; of: (app: string | null) => string }>
> = {
  [LeasePurpose.AppDeploy]: { noun: "deploy", of: (app) => `a deploy${app ? ` of ${app}` : ""}` },
  [LeasePurpose.AppRegister]: {
    noun: "registration",
    of: (app) => `a registration${app ? ` of ${app}` : ""}`,
  },
  [LeasePurpose.AppSecrets]: {
    noun: "secret change",
    of: (app) => `a secret change${app ? ` on ${app}` : ""}`,
  },
  [LeasePurpose.AppEmail]: {
    noun: "email change",
    of: (app) => `an email change${app ? ` on ${app}` : ""}`,
  },
  [LeasePurpose.GatewayDeploy]: { noun: "Gateway install", of: () => "a Gateway install" },
  [LeasePurpose.GatewayUpgrade]: { noun: "Gateway upgrade", of: () => "a Gateway upgrade" },
  [LeasePurpose.GatewayReconcile]: {
    noun: "Gateway update",
    of: () => "an update of the Gateway's apps",
  },
  [LeasePurpose.GatewaySecrets]: {
    noun: "Gateway settings change",
    of: () => "a change to the Gateway's settings",
  },
  [LeasePurpose.AccessSync]: {
    noun: "Cloudflare Access update",
    of: () => "an update of Cloudflare Access",
  },
  [LeasePurpose.DbRestore]: {
    noun: "database restore",
    of: (app) => `a restore of ${app ? `${app}'s database` : "the Gateway's database"}`,
  },
};

const CREATE_LEASE_TABLE = `CREATE TABLE IF NOT EXISTS _everyapp_deploy_lease (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  purpose TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  app TEXT,
  deployer TEXT,
  machine TEXT
)`;

/**
 * The columns added since the table was first created: a table an older
 * everyapp created gets them in place, and its rows read with them null.
 */
const ADDED_COLUMNS = ["app", "deployer", "machine"] as const;

// Take the lease when it's free, expired, or already ours. RETURNING gives
// back the holder only when this statement wrote the row.
const ACQUIRE = `INSERT INTO _everyapp_deploy_lease (id, holder, purpose, acquired_at, expires_at, app, deployer, machine)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, purpose = excluded.purpose,
  acquired_at = excluded.acquired_at, expires_at = excluded.expires_at,
  app = excluded.app, deployer = excluded.deployer, machine = excluded.machine
WHERE _everyapp_deploy_lease.expires_at < ?4 OR _everyapp_deploy_lease.holder = ?2
RETURNING holder`;

// Extends the lease only while it is still ours: no row back means it isn't.
const RENEW =
  "UPDATE _everyapp_deploy_lease SET expires_at = ? WHERE id = ? AND holder = ? RETURNING holder";

const LEASE_TTL_MS = 3 * 60_000;
const HEARTBEAT_MS = 30_000;
// Each renewal is a `cf d1 query` of its own: one that hangs is stopped
// well before the next heartbeat, never left to the runner's two minutes.
const HEARTBEAT_TIMEOUT_MS = 20_000;
// At least TTL + heartbeat: a lease outlives its holder's last renewal by
// the TTL, so a deploy that waits this long always outlasts a dead holder.
const WAIT_MS = 5 * 60_000;
const RETRY_MS = 5_000;

export interface LeaseHolder {
  /** "gateway" or "app:<workerName>". */
  id: string;
  holder: string;
  purpose: string;
  acquiredAt: number;
  expiresAt: number;
  /** The app's id, for an app's lease. */
  app: string | null;
  /** The Cloudflare login's email, when the run had one (not an API token). */
  deployer: string | null;
  /** The holder machine's name ("Bens-MacBook-Pro"). */
  machine: string;
}

export interface Lease {
  id: string;
  holder: string;
  /**
   * Call right before a step that can't be undone (migrating, `cf deploy`):
   * renews the lease, and throws `LEASE_LOST` when it is no longer this
   * deploy's, so two deploys never overlap.
   */
  check(): Promise<void>;
  /** Stop the heartbeat and give the lease up (only if still ours). */
  release(): Promise<void>;
}

interface AcquireLeaseOptions {
  db: D1Database;
  /** "gateway" or "app:<workerName>". */
  id: string;
  purpose: LeasePurpose;
  /** The app's id, for an app's lease. */
  app?: string;
  /** Where waits and heartbeat trouble are said. */
  out: EventSink;
  /** The step they are said on ("app.lease", "gateway.lease"). */
  step: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  heartbeatMs?: number;
}

/** This machine's name as a person knows it: its host name without a domain. */
function machineName(): string {
  return os.hostname().split(".")[0] || os.hostname();
}

function leaseHolderId(): string {
  return `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

const SELECT_LEASES = `SELECT id, holder, purpose, acquired_at, expires_at, ${ADDED_COLUMNS.join(", ")} FROM _everyapp_deploy_lease`;

const ready = new WeakMap<D1Database, Promise<void>>();

/**
 * The lease table, created or brought up to date, once per database a run
 * uses: SQLite has no ADD COLUMN IF NOT EXISTS, so the columns are looked
 * up first.
 */
function leaseTable(db: D1Database): Promise<void> {
  let table = ready.get(db);
  if (!table) {
    table = (async () => {
      const [, columns = []] = await db.run([
        { sql: CREATE_LEASE_TABLE },
        { sql: "PRAGMA table_info(_everyapp_deploy_lease)" },
      ]);
      const have = new Set(columns.map((column) => String(column["name"])));
      const missing = ADDED_COLUMNS.filter((column) => !have.has(column));
      if (missing.length > 0) {
        await db.run(
          missing.map((column) => ({
            sql: `ALTER TABLE _everyapp_deploy_lease ADD COLUMN ${column} TEXT`,
          })),
        );
      }
    })();
    // A failure is the run's to report; the next call tries again.
    table.catch(() => ready.delete(db));
    ready.set(db, table);
  }
  return table;
}

function toHolder(row: Record<string, unknown>): LeaseHolder {
  const holder = String(row["holder"]);
  return {
    id: String(row["id"]),
    holder,
    purpose: String(row["purpose"]),
    acquiredAt: Number(row["acquired_at"]),
    expiresAt: Number(row["expires_at"]),
    app: textOrNull(row["app"]),
    deployer: textOrNull(row["deployer"]),
    // A row from before the machine was recorded: its holder starts with the host.
    machine: textOrNull(row["machine"]) ?? holder.split(":")[0]!.split(".")[0]!,
  };
}

export async function readLease(
  db: D1Database,
  id: string,
): Promise<LeaseHolder | null> {
  await leaseTable(db);
  const [rows = []] = await db.run([{ sql: `${SELECT_LEASES} WHERE id = ?`, params: [id] }]);
  return rows[0] ? toHolder(rows[0]) : null;
}

/** Every deploy running now (an expired lease is a deploy that died). */
export async function readLiveLeases(
  db: D1Database,
  now = Date.now(),
): Promise<LeaseHolder[]> {
  await leaseTable(db);
  const [rows = []] = await db.run([
    { sql: `${SELECT_LEASES} WHERE expires_at > ? ORDER BY acquired_at`, params: [now] },
  ]);
  return rows.map(toHolder);
}

const purposeOf = (lease: Pick<LeaseHolder, "purpose">) =>
  PURPOSES[lease.purpose as LeasePurpose] as (typeof PURPOSES)[LeasePurpose] | undefined;

/** What a lease's holder is doing: "a deploy of todo", "a Gateway upgrade". */
function leaseActivity(lease: Pick<LeaseHolder, "purpose" | "app">): string {
  return purposeOf(lease)?.of(lease.app) ?? "another run";
}

/** Who holds it, and since when: "ben@example.com on Bens-MacBook-Pro, started 1m ago". */
function leaseOrigin(lease: LeaseHolder, now = Date.now()): string {
  return `${lease.deployer ? `${lease.deployer} on ` : ""}${lease.machine}, started ${roughly(now - lease.acquiredAt)} ago`;
}

/** A lease for a person: "a deploy of todo from ben@example.com on Bens-MacBook-Pro, started 1m ago". */
export function describeLeaseHolder(lease: LeaseHolder, now = Date.now()): string {
  return `${leaseActivity(lease)} from ${leaseOrigin(lease, now)}`;
}

export async function acquireLease({
  db,
  id,
  purpose,
  app,
  out,
  step,
  now = Date.now,
  // The global timer, which tests fake (node:timers/promises isn't).
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = WAIT_MS,
  heartbeatMs = HEARTBEAT_MS,
}: AcquireLeaseOptions): Promise<Lease> {
  const holder = leaseHolderId();
  const deadline = now() + waitMs;
  // What the lease locks, for a person: "todo", "the Gateway".
  const target = id === "gateway" ? "the Gateway" : (app ?? "this app");
  await leaseTable(db);
  let acquiredAt: number;
  let waitedFor: LeaseHolder | null = null;
  for (;;) {
    const at = now();
    const [won = []] = await db.run([
      {
        sql: ACQUIRE,
        params: [id, holder, purpose, at, at + LEASE_TTL_MS, app ?? null, loggedInAs(), machineName()],
      },
    ]);
    if (won[0]?.["holder"] === holder) {
      acquiredAt = at;
      break;
    }

    const current = await readLease(db, id);
    if (now() >= deadline) {
      throw new EveryAppError(
        "LEASE_HELD",
        current
          ? `${capitalize(leaseActivity(current))} is still running after ${roughly(waitMs)}\nIt's from ${current.deployer ? `${current.deployer} on ` : ""}${current.machine}. If it stopped without cleaning up, it's released within ${roughly(current.expiresAt - now())}.`
          : `Couldn't take hold of ${target} after ${roughly(waitMs)}`,
        {
          retryable: true,
          rerunNote: `once it's done (${CLI} status shows it)`,
          ...(current ? { data: { holder: current } } : {}),
        },
      );
    }
    if (current) {
      waitedFor = current;
      out.emit({
        type: "progress",
        step,
        message: `Waiting for ${leaseActivity(current)} to finish (${leaseOrigin(current, now())})`,
        data: { holder: current },
      });
    }
    await sleep(RETRY_MS);
  }
  if (waitedFor) {
    out.emit({
      type: "step",
      step,
      status: "ok",
      message: `The other ${purposeOf(waitedFor)?.noun ?? "run"} finished.`,
      data: { waitedFor: purposeOf(waitedFor)?.noun ?? "run" },
    });
  }

  // When the last renewal that found the lease ours started: the lease is
  // ours until then + TTL, whatever happened since.
  let renewedAt = acquiredAt;
  // Whether the lease is no longer this deploy's.
  let lost = false;
  let lostReported = false;
  let released = false;
  let renewing: Promise<void> | null = null;
  const warn = (message: string) =>
    out.emit({ type: "warning", code: "LEASE_HEARTBEAT", step, message });

  const renewOnce = async () => {
    if (lost || released) return;
    const at = now();
    try {
      const [renewed = []] = await db.run(
        [{ sql: RENEW, params: [at + LEASE_TTL_MS, id, holder] }],
        { timeoutMs: HEARTBEAT_TIMEOUT_MS },
      );
      if (renewed.length > 0) renewedAt = at;
      else lost = true;
    } catch (error) {
      if (released) return;
      const failingFor = now() - renewedAt;
      if (failingFor > LEASE_TTL_MS / 2) {
        lost = true;
        return;
      }
      const reason =
        error instanceof CfTimeoutError
          ? `The database didn't answer within ${roughly(HEARTBEAT_TIMEOUT_MS)}`
          : errorMessage(error);
      warn(
        `Can't reach Cloudflare to keep hold of ${target} (${roughly(failingFor)} so far)\n${reason}. Another run can take over in ${roughly(renewedAt + LEASE_TTL_MS - now())} if this continues.`,
      );
    }
  };
  // One renewal at a time: the heartbeat and check() share it.
  const renew = () =>
    (renewing ??= renewOnce().finally(() => {
      renewing = null;
    }));

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          void renew().then(() => {
            if (!lost || released || lostReported) return;
            lostReported = true;
            clearInterval(heartbeat);
            warn(
              `This run lost its hold on ${target}\nIts hold expired, and another run may have started. It stops before its next change.`,
            );
          });
        }, heartbeatMs)
      : undefined;
  heartbeat?.unref();

  const free = () =>
    db.run([
      {
        sql: "DELETE FROM _everyapp_deploy_lease WHERE id = ? AND holder = ?",
        params: [id, holder],
      },
    ]);
  const stop = () => {
    released = true;
    clearInterval(heartbeat);
  };
  // An interrupted deploy frees the lease too, so the next one needn't wait
  // for it to expire.
  const forget = onInterrupt({
    label: `freeing ${target} for other runs`,
    async: async () => {
      stop();
      await free();
    },
  });
  return {
    id,
    holder,
    async check() {
      // A renewal already under way may have started before the lease was
      // lost: run one that starts now.
      await renewing;
      await renew();
      if (lost) {
        lostReported = true;
        clearInterval(heartbeat);
        throw new EveryAppError(
          "LEASE_LOST",
          `Stopped: this run lost its hold on ${target}\nIts hold expired, so it stopped before its next change to avoid overlapping another run.`,
          { retryable: true },
        );
      }
    },
    async release() {
      stop();
      await free();
      forget();
    },
  };
}

/** The Gateway's deploy lease (and its database's restore-point target). */
export const GATEWAY_LEASE_ID = "gateway";

/** The lease the Access applications are reconciled under: `access on`, and the sync after a deploy or delete. */
export const ACCESS_LEASE_ID = "access";

/** An app's deploy lease (and its database's restore-point target). */
export function appLeaseId(workerName: string): string {
  return `app:${workerName}`;
}

/** Take an app's deploy lease, saying who has it while waiting (step `app.lease`). */
export function acquireAppLease(
  { db, out }: { db: D1Database; out: EventSink },
  { workerName, appId, purpose }: { workerName: string; appId: string; purpose: LeasePurpose },
): Promise<Lease> {
  return acquireLease({
    db,
    id: appLeaseId(workerName),
    purpose,
    app: appId,
    out,
    step: "app.lease",
  });
}

/** Take the Gateway's deploy lease, saying who has it while waiting (step `gateway.lease`). */
export function acquireGatewayLease(
  options: { db: D1Database; out: EventSink; leaseWaitMs?: number; sleep?: (ms: number) => Promise<void> },
  purpose: LeasePurpose,
): Promise<Lease> {
  return acquireLease({
    db: options.db,
    id: GATEWAY_LEASE_ID,
    purpose,
    out: options.out,
    step: "gateway.lease",
    waitMs: options.leaseWaitMs,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
}
