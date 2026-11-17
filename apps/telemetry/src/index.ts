// telemetry.everyapp.com: receives the usage report a self-hosted Gateway sends once a day
// (apps/every-app-gateway/src/server/telemetry/, https://everyapp.com/docs/telemetry).
//
// It stores the report's body and nothing else: no address, no header, no time finer than the
// report's own day. Cloudflare adds the sending Gateway's zone name to the request (the CF-Worker
// header); nothing here reads it, and Workers Logs are off (wrangler.jsonc) so it isn't logged.
// A body with a key this file doesn't name is refused, so a field can't be added quietly.

/** The apps of ours a report may name. "other" is every app of the operator's own, together. */
const APPS = new Set(["openseo", "crm", "openmail", "analytics", "scribe", "repolens", "other"]);
/** `members` and `active_members_7d` are capped here before they are sent. */
const MEMBER_CAP = 1000;
const MAX_BODY_BYTES = 4096;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Reports are kept this long (the cron below deletes older ones). */
const KEEP_MONTHS = 25;

const TOP_KEYS = ["schema", "install", "day", "version", "installed", "members", "active_members_1d", "active_members_7d", "apps", "mcp_servers", "app_use_1d", "mcp_use_1d"];
const APP_USE_KEYS = ["app", "active_members", "tool_calls"];
const MCP_USE_KEYS = ["active_members", "tool_calls"];

export interface AppUse {
  app: string;
  active_members: number;
  tool_calls: number;
}
export interface Report {
  schema: 1;
  install: string;
  day: string;
  version: string;
  installed: string;
  members: number;
  active_members_1d: number;
  active_members_7d: number;
  /** Deployed apps. MCP servers are counted in `mcp_servers`, not here. */
  apps: number;
  mcp_servers: number;
  app_use_1d: AppUse[];
  /** Use of all the MCP servers together; none is named. */
  mcp_use_1d: { active_members: number; tool_calls: number };
}

/** A count as a Gateway sends it: a whole number rounded down to one significant digit. */
function isRoundedCount(value: unknown, max = 1e9): value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) return false;
  if (value === 0) return true;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return value % magnitude === 0;
}

function hasExactly(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The report, or why it is refused. `now` decides which days are accepted: yesterday and the day before (UTC). */
export function parseReport(body: unknown, now: number): Report | string {
  if (!hasExactly(body, TOP_KEYS)) return "keys";
  if (body.schema !== 1) return "schema";
  if (typeof body.install !== "string" || !/^[0-9a-f]{32}$/.test(body.install)) return "install";
  if (typeof body.day !== "string" || (body.day !== utcDay(now - DAY_MS) && body.day !== utcDay(now - 2 * DAY_MS))) return "day";
  if (typeof body.version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z]{1,16}(\.[0-9A-Za-z]{1,16}){0,3})?$/.test(body.version)) return "version";
  if (typeof body.installed !== "string" || !/^20\d\d-(0[1-9]|1[0-2])$/.test(body.installed)) return "installed";
  if (!isRoundedCount(body.members, MEMBER_CAP)) return "members";
  if (!isRoundedCount(body.active_members_1d, MEMBER_CAP)) return "active_members_1d";
  if (!isRoundedCount(body.active_members_7d, MEMBER_CAP)) return "active_members_7d";
  if (!isRoundedCount(body.apps)) return "apps";
  if (!isRoundedCount(body.mcp_servers)) return "mcp_servers";
  const mcp = body.mcp_use_1d;
  if (!hasExactly(mcp, MCP_USE_KEYS) || !isRoundedCount(mcp.active_members, MEMBER_CAP) || !isRoundedCount(mcp.tool_calls)) return "mcp_use_1d";
  const use = body.app_use_1d;
  if (!Array.isArray(use) || use.length > APPS.size) return "app_use_1d";
  const seen = new Set<string>();
  for (const row of use as unknown[]) {
    if (!hasExactly(row, APP_USE_KEYS)) return "app_use_1d";
    if (typeof row.app !== "string" || !APPS.has(row.app) || seen.has(row.app)) return "app_use_1d";
    if (!isRoundedCount(row.active_members, MEMBER_CAP) || !isRoundedCount(row.tool_calls)) return "app_use_1d";
    seen.add(row.app);
  }
  return body as unknown as Report;
}

// The slice of the Workers D1 API used here (kept local so tests can run it on SQLite).
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
}
export interface D1 {
  prepare(sql: string): D1Statement;
}
export interface Env {
  DB: D1;
}

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function handle(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/report") return text(404, "Not found\n");
  if (request.method !== "POST") return text(405, "POST only\n");
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return text(400, "Refused: too large\n");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return text(400, "Refused: not JSON\n");
  }
  const report = parseReport(body, now);
  if (typeof report === "string") return text(400, `Refused: ${report}\n`);
  // The first report for a Gateway's day wins; a second one changes nothing.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO reports (install, day, version, installed, members, active_members_1d, active_members_7d, apps, mcp_servers, app_use_1d, mcp_active_members_1d, mcp_tool_calls_1d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      report.install,
      report.day,
      report.version,
      report.installed,
      report.members,
      report.active_members_1d,
      report.active_members_7d,
      report.apps,
      report.mcp_servers,
      JSON.stringify(report.app_use_1d),
      report.mcp_use_1d.active_members,
      report.mcp_use_1d.tool_calls,
    )
    .run();
  return new Response(null, { status: 204 });
}

/** Delete reports older than KEEP_MONTHS. */
export async function prune(env: Env, now = Date.now()): Promise<void> {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - KEEP_MONTHS);
  await env.DB.prepare("DELETE FROM reports WHERE day < ?").bind(utcDay(cutoff.getTime())).run();
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: (_event: unknown, env: Env) => prune(env),
};
