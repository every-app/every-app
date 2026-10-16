/**
 * The deploy lease: a row in the gateway's own D1 that serializes
 * deploys. `gateway` covers the gateway (deploy, upgrade, reconcile), and
 * `app:<worker>` one app's migrations and upload. The CLI creates the table
 * itself (it isn't in the gateway's schema), in the same request that takes
 * the lease, so the lease exists before any migration runs.
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
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import type { D1Database } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { onInterrupt } from "@/lib/interrupt";
import { CLI } from "@/lib/output/command";

const CREATE_LEASE_TABLE = `CREATE TABLE IF NOT EXISTS _everyapp_deploy_lease (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  purpose TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

// Take the lease when it's free, expired, or already ours. RETURNING gives
// back the holder only when this statement wrote the row.
const ACQUIRE = `INSERT INTO _everyapp_deploy_lease (id, holder, purpose, acquired_at, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, purpose = excluded.purpose,
  acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
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
  /** What the holder is doing, shown to anyone waiting. */
  purpose: string;
  onWait?: (current: LeaseHolder) => void;
  /**
   * A renewal failed, or the heartbeat found the lease lost: say so. The
   * deploy stops at its next `check()` once the lease is lost.
   */
  onHeartbeatProblem?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  heartbeatMs?: number;
}

function leaseHolderId(): string {
  return `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

const iso = (ms: number) => new Date(ms).toISOString();

const SELECT_LEASES =
  "SELECT id, holder, purpose, acquired_at, expires_at FROM _everyapp_deploy_lease";

function toHolder(row: Record<string, unknown>): LeaseHolder {
  return {
    id: String(row["id"]),
    holder: String(row["holder"]),
    purpose: String(row["purpose"]),
    acquiredAt: Number(row["acquired_at"]),
    expiresAt: Number(row["expires_at"]),
  };
}

export async function readLease(
  db: D1Database,
  id: string,
): Promise<LeaseHolder | null> {
  const [, rows = []] = await db.run([
    { sql: CREATE_LEASE_TABLE },
    { sql: `${SELECT_LEASES} WHERE id = ?`, params: [id] },
  ]);
  return rows[0] ? toHolder(rows[0]) : null;
}

/** Every deploy running now (an expired lease is a deploy that died). */
export async function readLiveLeases(
  db: D1Database,
  now = Date.now(),
): Promise<LeaseHolder[]> {
  const [, rows = []] = await db.run([
    { sql: CREATE_LEASE_TABLE },
    {
      sql: `${SELECT_LEASES} WHERE expires_at > ? ORDER BY acquired_at`,
      params: [now],
    },
  ]);
  return rows.map(toHolder);
}

/**
 * Who holds a lease and since when, and where to see it: for the error a
 * deploy that gave up waiting raises.
 */
function describeHolder(current: LeaseHolder): string {
  return `${current.holder} has held the deploy lease "${current.id}" (${current.purpose}) since ${iso(current.acquiredAt)}; \`${CLI} status\` shows it while that deploy runs. If it died, the lease expires by ${iso(current.expiresAt)} and the next run takes it.`;
}

export async function acquireLease({
  db,
  id,
  purpose,
  onWait,
  onHeartbeatProblem = (message) => console.error(message),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = WAIT_MS,
  heartbeatMs = HEARTBEAT_MS,
}: AcquireLeaseOptions): Promise<Lease> {
  const holder = leaseHolderId();
  const deadline = now() + waitMs;
  let acquiredAt: number;
  for (;;) {
    const at = now();
    const [, won = []] = await db.run([
      { sql: CREATE_LEASE_TABLE },
      { sql: ACQUIRE, params: [id, holder, purpose, at, at + LEASE_TTL_MS] },
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
          ? `Another deploy is running: ${describeHolder(current)}`
          : `Couldn't take the deploy lease "${id}".`,
        { retryable: true },
      );
    }
    if (current) onWait?.(current);
    await sleep(RETRY_MS);
  }

  // When the last renewal that found the lease ours started: the lease is
  // ours until then + TTL, whatever happened since.
  let renewedAt = acquiredAt;
  // Why the lease is no longer this deploy's, once it isn't.
  let lost: string | null = null;
  let lostReported = false;
  let released = false;
  let renewing: Promise<void> | null = null;

  const renewOnce = async () => {
    if (lost || released) return;
    const at = now();
    try {
      const [renewed = []] = await db.run(
        [{ sql: RENEW, params: [at + LEASE_TTL_MS, id, holder] }],
        { timeoutMs: HEARTBEAT_TIMEOUT_MS },
      );
      if (renewed.length > 0) {
        renewedAt = at;
      } else {
        lost = `The deploy lease "${id}" is no longer this deploy's: it expired, and another deploy may hold it now.`;
      }
    } catch (error) {
      if (released) return;
      const reason = error instanceof Error ? error.message : String(error);
      const failingFor = now() - renewedAt;
      const expires = iso(renewedAt + LEASE_TTL_MS);
      if (failingFor > LEASE_TTL_MS / 2) {
        lost = `Couldn't renew the deploy lease "${id}" for ${Math.round(failingFor / 1000)} s (${reason}); it expires at ${expires}, and another deploy could take it then.`;
      } else {
        onHeartbeatProblem(
          `Couldn't renew the deploy lease "${id}" (${reason}); it expires at ${expires} unless a later try works.`,
        );
      }
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
            onHeartbeatProblem(lost);
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
          `${lost} Stopped before the next step that changes anything, so two deploys don't overlap; run the command again.`,
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
