/**
 * `GET /health` on the gateway's own host, for uptime monitors.
 *
 * Public: Cloudflare Access lets it through (`GATEWAY_BYPASS_PATHS` in
 * packages/cli/src/lib/access/plan.ts), so it reads no session, names no
 * version and says one thing: whether the gateway can reach its database
 * (`SELECT 1` against D1, bounded to two seconds). 200 `{"status":"ok"}`
 * or 503 `{"status":"error","database":"down"}`, never cached. One probe
 * runs at a time per isolate and its answer is reused for a few seconds,
 * so a flood of requests costs CPU, not D1, while a monitor polling every
 * 30 to 60 seconds still sees fresh truth. HEAD answers the same without
 * a body; any other method is 405.
 */

/** What the probe needs of `env.DB`. */
export interface HealthDatabase {
  prepare(query: string): { first(): Promise<unknown> };
}

export const HEALTH_PATH = "/health";
/** How long the database gets to answer before it counts as down. */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;
/** How long one probe's answer stands in for the next requests. */
export const HEALTH_PROBE_REUSE_MS = 5_000;

let inflight: Promise<boolean> | null = null;
let last: { ok: boolean; at: number } | null = null;

export function resetHealthForTests(): void {
  inflight = null;
  last = null;
}

async function probe(db: HealthDatabase): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_PROBE_TIMEOUT_MS);
  });
  // The query starts inside a promise so a binding that is missing, or
  // whose prepare() throws, counts as down rather than escaping as an
  // exception the monitor reads as Cloudflare's error page.
  const query = (async () => {
    await db.prepare("SELECT 1").first();
    return true;
  })().catch(() => false);
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function databaseUp(db: HealthDatabase, now: number): Promise<boolean> {
  if (last && now - last.at < HEALTH_PROBE_REUSE_MS) return last.ok;
  if (!inflight) {
    inflight = probe(db)
      .then((ok) => {
        last = { ok, at: now };
        return ok;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function serveHealth(
  request: Request,
  db: HealthDatabase,
  now: () => number = Date.now,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  const ok = await databaseUp(db, now());
  const body = ok ? { status: "ok" } : { status: "error", database: "down" };
  return new Response(method === "HEAD" ? null : JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
