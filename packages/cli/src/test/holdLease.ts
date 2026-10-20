/**
 * Another run holding a deploy lease, for tests of what waits on it: taken
 * at once, without a heartbeat, saying nothing.
 */
import type { D1Database } from "@/lib/cf/d1";
import { acquireLease, type Lease, type LeasePurpose } from "@/lib/gateway/lease";
import { createNdjsonSink } from "@/lib/output/events";

export function holdLease(
  db: D1Database,
  id: string,
  purpose: LeasePurpose,
  app?: string,
): Promise<Lease> {
  return acquireLease({
    db,
    id,
    purpose,
    ...(app ? { app } : {}),
    out: createNdjsonSink(() => undefined),
    step: "test.lease",
    heartbeatMs: 0,
  });
}
