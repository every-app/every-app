/**
 * The gateway's hourly MCP housekeeping (the `scheduled` handler):
 *
 *  - delete `mcp_tool_calls` rows older than MCP_AUDIT_RETENTION_DAYS (90 by
 *    default), up to 20,000 a run;
 *  - mark connections unused for longer than their grants live as expired,
 *    so the list of connections stays honest;
 *  - delete rate limit counters whose window ended (the client registration
 *    budget's);
 *  - delete usage counters past their retention (daily rows after 13
 *    months, monthly after 25), up to 10,000 rows of each a run
 *    (repositories/UsageRepository.ts);
 *  - delete event deliveries older than EVENT_RETENTION_DAYS (30) and
 *    events older than AUDIT_RETENTION_DAYS (90: the audit log,
 *    docs/design/2026-10-events-out.md), up to 10,000 of each a run;
 *  - sweep expired and orphaned OAuth grants and tokens from OAUTH_KV with
 *    the library's purgeExpiredData, resuming from a cursor kept in KV;
 *  - re-list the tools of every active remote MCP app whose snapshot is
 *    older than an hour (server/remote-mcp/relist.ts), up to 50 a run.
 *
 * Each step runs even when another fails, and the run logs one summary line.
 */
import {
  AUDIT_RETENTION_DAYS,
  EVENT_RETENTION_DAYS,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import { EventDeliveryRepository } from "@/server/repositories/EventDeliveryRepository";
import { EventRepository } from "@/server/repositories/EventRepository";
import { McpToolCallRepository } from "@/server/repositories/McpToolCallRepository";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import { McpConnectionService } from "@/server/services/McpConnectionService";
import { getMcpAuth } from "./config";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const MAX_AUDIT_RETENTION_DAYS = 3650;
// Grants lapse after 30 days without a refresh; a day's margin covers the
// ten-minute resolution of last_used_at.
const CONNECTION_IDLE_DAYS = 31;
// `{"cursor": …, "failures": n}`: where the sweep resumes, and how many runs
// in a row failed from there.
const PURGE_CURSOR_KEY = "purge-cursor";
/** Failed runs in a row after which the sweep starts over. */
const MAX_PURGE_FAILURES = 3;
// The library's default: checking a record takes a few KV operations, and
// an invocation gets 1,000.
const PURGE_BATCH_SIZE = 50;

function retentionDays(value: string | undefined): number {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1
    ? Math.min(days, MAX_AUDIT_RETENTION_DAYS)
    : DEFAULT_AUDIT_RETENTION_DAYS;
}

async function step<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T | "failed"> {
  try {
    return await run();
  } catch (error) {
    logEvent(
      "mcp.maintenance.failed",
      {
        step: name,
        message: error instanceof Error ? error.message : String(error),
      },
      "error",
    );
    return "failed";
  }
}

type PurgeState = { cursor: string; failures: number };

async function readPurgeState(kv: KVNamespace): Promise<PurgeState | null> {
  try {
    const state = JSON.parse((await kv.get(PURGE_CURSOR_KEY)) ?? "null") as {
      cursor?: unknown;
      failures?: unknown;
    } | null;
    return typeof state?.cursor === "string"
      ? { cursor: state.cursor, failures: Number(state.failures) || 0 }
      : null;
  } catch {
    return null;
  }
}

async function purgeOauthStorage(env: Cloudflare.Env) {
  const mcpAuth = getMcpAuth(env);
  if (!mcpAuth) return "skipped" as const;
  const saved = await readPurgeState(env.OAUTH_KV);
  let result;
  try {
    result = await mcpAuth.authorizationServer.purgeExpiredData(env, {
      batchSize: PURGE_BATCH_SIZE,
      cursor: saved?.cursor,
    });
  } catch (error) {
    // The next run resumes from the same cursor, unless the cursor itself
    // is refused (one from another version, say) or runs keep failing from
    // it: then the next run starts a new sweep instead of failing forever.
    if (saved) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = saved.failures + 1;
      if (/cursor/i.test(message) || failures >= MAX_PURGE_FAILURES) {
        await env.OAUTH_KV.delete(PURGE_CURSOR_KEY);
      } else {
        await env.OAUTH_KV.put(
          PURGE_CURSOR_KEY,
          JSON.stringify({ cursor: saved.cursor, failures }),
        );
      }
    }
    throw error;
  }
  if (result.cursor) {
    await env.OAUTH_KV.put(
      PURGE_CURSOR_KEY,
      JSON.stringify({ cursor: result.cursor, failures: 0 }),
    );
  } else if (saved) {
    await env.OAUTH_KV.delete(PURGE_CURSOR_KEY);
  }
  // Not "tokens_*": log fields named like credentials are redacted.
  return {
    grants_checked: result.grantsChecked,
    grants_purged: result.grantsPurged,
    access_records_checked: result.tokensChecked,
    access_records_purged: result.tokensPurged,
    done: result.done,
  };
}

export async function runMcpMaintenance(
  env: Cloudflare.Env,
  now = new Date(),
): Promise<void> {
  const days = retentionDays(env.MCP_AUDIT_RETENTION_DAYS);
  const audit = await step("audit", () =>
    McpToolCallRepository.deleteRecordedBefore(
      new Date(now.getTime() - days * DAY_MS),
    ),
  );
  const connectionsExpired = await step("connections", () =>
    McpConnectionService.expireIdle(
      new Date(now.getTime() - CONNECTION_IDLE_DAYS * DAY_MS),
    ),
  );
  const countersDeleted = await step("rate_limits", () =>
    RateLimitCounterRepository.deleteExpired(now),
  );
  const usage = await step("usage", () => UsageRepository.deleteOlderThan(now));
  // Deliveries are the queue and its log; events are the audit log and
  // stay three times as long.
  const eventsPruned = await step("events", () =>
    EventRepository.deleteOlderThan(
      new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS),
    ),
  );
  const deliveriesPruned = await step("event_deliveries", () =>
    EventDeliveryRepository.deleteOlderThan(
      new Date(now.getTime() - EVENT_RETENTION_DAYS * DAY_MS),
    ),
  );
  const purge = await step("oauth_purge", () => purgeOauthStorage(env));
  // Remote MCP apps: re-list each server's tools once an hour, so a
  // changed list reaches connected clients without waiting for a call.
  const remoteMcp = await step("remote_mcp", async () => {
    const { relistStaleRemoteMcpApps } = await import(
      "@/server/remote-mcp/relist"
    );
    return relistStaleRemoteMcpApps(now);
  });
  // Rows left past the retention after a full run: more calls an hour than
  // a run deletes, which needs a look. Usage rows age out a month at a
  // time, so being behind for a few runs after a month boundary is normal.
  const auditBehind = audit !== "failed" && !audit.done;
  const usageBehind = usage !== "failed" && !usage.done;
  logEvent(
    "mcp.maintenance",
    {
      audit_retention_days: days,
      audit_deleted: audit === "failed" ? audit : audit.deleted,
      ...(auditBehind ? { audit_behind: true } : {}),
      connections_expired: connectionsExpired,
      rate_limit_counters_deleted: countersDeleted,
      usage_daily_deleted: usage === "failed" ? usage : usage.daily,
      usage_monthly_deleted: usage === "failed" ? usage : usage.monthly,
      ...(usageBehind ? { usage_behind: true } : {}),
      events_deleted:
        eventsPruned === "failed" ? eventsPruned : eventsPruned.deleted,
      event_deliveries_deleted:
        deliveriesPruned === "failed"
          ? deliveriesPruned
          : deliveriesPruned.deleted,
      oauth_purge: purge,
      remote_mcp_relisted: remoteMcp,
    },
    auditBehind ? "warn" : "log",
  );
}
