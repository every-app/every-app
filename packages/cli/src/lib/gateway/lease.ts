/**
 * The deploy lease: a row in the gateway's own D1 that serializes
 * deploys. `gateway` covers the gateway (deploy, upgrade, reconcile), and
 * `app:<worker>` one app's migrations and upload. The CLI creates the table
 * itself (it isn't in the gateway's schema), in the same request that takes
 * the lease, so the lease exists before any migration runs.
 *
 * A lease lasts 10 minutes and a heartbeat renews it every minute, so a
 * crashed deploy frees it within 10 minutes; `--break-lease` takes it over
 * sooner, once someone confirms that its holder died.
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import enquirer from "enquirer";
import type { D1Database } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { onInterrupt } from "@/lib/interrupt";

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

const LEASE_TTL_MS = 10 * 60_000;
const HEARTBEAT_MS = 60_000;
const WAIT_MS = 5 * 60_000;
const RETRY_MS = 5_000;

interface LeaseHolder {
  holder: string;
  purpose: string;
  acquiredAt: number;
  expiresAt: number;
}

/**
 * Whether to take over a lease someone holds (`--break-lease`): it says
 * yes only for a holder that died, so it is asked about that very holder.
 */
export type BreakLease = (current: LeaseHolder) => Promise<boolean>;

interface Lease {
  id: string;
  holder: string;
  /** Stop the heartbeat and give the lease up (only if still ours). */
  release(): Promise<void>;
}

interface AcquireLeaseOptions {
  db: D1Database;
  /** "gateway" or "app:<workerName>". */
  id: string;
  /** What the holder is doing, shown to anyone waiting. */
  purpose: string;
  /** Asked whether to take the lease over from a holder that has it now. */
  breakLease?: BreakLease;
  onWait?: (current: LeaseHolder) => void;
  /** A heartbeat failed, or found the lease taken: say so, the deploy goes on. */
  onHeartbeatProblem?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  heartbeatMs?: number;
}

/**
 * `--break-lease` from a command's flags: at a terminal it asks first;
 * unattended it needs `--yes` as well, since nobody sees whose lease it is.
 */
export function confirmLeaseBreak({
  breakLease,
  yes,
  interactive,
}: {
  breakLease?: boolean;
  yes?: boolean;
  interactive: boolean;
}): BreakLease | undefined {
  if (!breakLease) return undefined;
  return async (current) => {
    const held = `${current.holder} has held the ${current.purpose} lease since ${new Date(current.acquiredAt).toISOString()}`;
    if (yes) return true;
    if (!interactive) {
      throw new EveryAppError(
        "CONFIRMATION_REQUIRED",
        `${held}. --break-lease takes it over only once you confirm that deploy died: pass --yes too, or run this in a terminal.`,
      );
    }
    const { confirmed } = await enquirer.prompt<{ confirmed: boolean }>({
      type: "confirm",
      name: "confirmed",
      message: `${held}. Take it over? Only if that deploy died.`,
      initial: false,
    });
    return confirmed;
  };
}

function leaseHolderId(): string {
  return `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

export async function readLease(
  db: D1Database,
  id: string,
): Promise<LeaseHolder | null> {
  const [, rows = []] = await db.run([
    { sql: CREATE_LEASE_TABLE },
    {
      sql: "SELECT holder, purpose, acquired_at, expires_at FROM _everyapp_deploy_lease WHERE id = ?",
      params: [id],
    },
  ]);
  const row = rows[0];
  return row
    ? {
        holder: String(row["holder"]),
        purpose: String(row["purpose"]),
        acquiredAt: Number(row["acquired_at"]),
        expiresAt: Number(row["expires_at"]),
      }
    : null;
}

export async function acquireLease({
  db,
  id,
  purpose,
  breakLease,
  onWait,
  onHeartbeatProblem = (message) => console.error(message),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = WAIT_MS,
  heartbeatMs = HEARTBEAT_MS,
}: AcquireLeaseOptions): Promise<Lease> {
  const holder = leaseHolderId();
  if (breakLease) {
    const current = await readLease(db, id);
    if (current && current.expiresAt > now()) {
      if (!(await breakLease(current))) {
        throw new EveryAppError(
          "LEASE_HELD",
          `Left the ${id} lease with ${current.holder} (${current.purpose}).`,
        );
      }
      // Only that holder's: not a lease someone took since.
      await db.run([
        {
          sql: "DELETE FROM _everyapp_deploy_lease WHERE id = ? AND holder = ?",
          params: [id, current.holder],
        },
      ]);
    }
  }

  const deadline = now() + waitMs;
  for (;;) {
    const at = now();
    const [, won = []] = await db.run([
      { sql: CREATE_LEASE_TABLE },
      { sql: ACQUIRE, params: [id, holder, purpose, at, at + LEASE_TTL_MS] },
    ]);
    if (won[0]?.["holder"] === holder) break;

    const current = await readLease(db, id);
    if (now() >= deadline) {
      throw new EveryAppError(
        "LEASE_HELD",
        current
          ? `Another deploy holds the ${id} lease: ${current.holder} (${current.purpose}) since ${new Date(current.acquiredAt).toISOString()}. Wait for it, or run again with --break-lease if it died.`
          : `Couldn't take the ${id} deploy lease.`,
        { retryable: true },
      );
    }
    if (current) onWait?.(current);
    await sleep(RETRY_MS);
  }

  // A missed heartbeat isn't fatal (the lease lasts 10 minutes), but a
  // deploy that runs on without its lease can overlap another: say so.
  let renewedUntil = now() + LEASE_TTL_MS;
  const renew = async () => {
    const at = now();
    try {
      const [renewed = []] = await db.run([
        {
          sql: "UPDATE _everyapp_deploy_lease SET expires_at = ? WHERE id = ? AND holder = ? RETURNING holder",
          params: [at + LEASE_TTL_MS, id, holder],
        },
      ]);
      if (renewed.length === 0) {
        onHeartbeatProblem(
          `The ${id} deploy lease was taken over (--break-lease) while this deploy runs; another deploy may overlap it.`,
        );
        return;
      }
      renewedUntil = at + LEASE_TTL_MS;
    } catch (error) {
      onHeartbeatProblem(
        `Couldn't renew the ${id} deploy lease (${error instanceof Error ? error.message : String(error)}); it expires at ${new Date(renewedUntil).toISOString()} unless a later try works.`,
      );
    }
  };
  const heartbeat =
    heartbeatMs > 0 ? setInterval(() => void renew(), heartbeatMs) : undefined;
  heartbeat?.unref();

  const free = () =>
    db.run([
      {
        sql: "DELETE FROM _everyapp_deploy_lease WHERE id = ? AND holder = ?",
        params: [id, holder],
      },
    ]);
  // An interrupted deploy frees the lease too, so the next one needn't wait
  // for it to expire.
  const forget = onInterrupt({
    async: async () => {
      clearInterval(heartbeat);
      await free();
    },
  });
  return {
    id,
    holder,
    async release() {
      clearInterval(heartbeat);
      await free();
      forget();
    },
  };
}
