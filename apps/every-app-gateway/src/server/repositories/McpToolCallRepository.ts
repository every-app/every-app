import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import type { ToolCallAuditEvent } from "@every-app/toolbus";
import { db } from "@/db";
import { apps, mcpToolCalls, members, users } from "@/db/schema";
import type {
  ToolCallApp,
  ToolCallCursor,
  ToolCallsPage,
} from "@/types/activity";

/** Rows deleted per statement when pruning, so one prune never runs long. */
const PRUNE_BATCH_SIZE = 1000;
/**
 * Statements per prune run (the hourly cron's): 20,000 rows an hour, and
 * well inside D1's 50 queries per invocation on the free plan. Whatever is
 * left goes on the next run.
 */
const PRUNE_MAX_BATCHES = 20;
/** The most rows one listed page carries; the server function's cap too. */
export const TOOL_CALL_PAGE_MAX = 200;

/** Record one tool call: who, which tool, the decision and outcome. */
async function insert(event: ToolCallAuditEvent): Promise<void> {
  await db.insert(mcpToolCalls).values({
    id: event.callId,
    createdAt: new Date(),
    organizationId: event.organizationId,
    userId: event.userId,
    credentialKind: event.credentialKind,
    credentialId: event.credentialId,
    clientName: event.clientName ?? null,
    clientInfo: event.clientInfo ?? null,
    surface: event.surface,
    appRowId: event.appRowId ?? null,
    appSlug: event.appId ?? null,
    toolName: event.tool,
    risk: event.risk ?? null,
    decision: event.decision,
    reason: event.reason ?? null,
    outcome: event.outcome,
    durationMs: event.durationMs,
    argsDigest: event.argsDigest ?? null,
    resultBytes: event.resultBytes ?? null,
    protocolVersion: event.protocolVersion ?? null,
    requestId: event.requestId ?? null,
  });
}

interface ListForOrganizationOptions {
  organizationId: string;
  /** Rows per page, clamped to 1..`TOOL_CALL_PAGE_MAX`. */
  limit: number;
  /** The page continues before this row (the previous page's `nextBefore`). */
  before?: ToolCallCursor | undefined;
  appRowId?: string | undefined;
  userId?: string | undefined;
  decision?: "allowed" | "blocked" | undefined;
  risk?: string | undefined;
  /** Rows recorded at or after this time only. */
  since?: Date | undefined;
}

/**
 * Whether the app a call names is gone: deleted through the product (its
 * row stays as a tombstone, name and all, so the join still finds it) or
 * its row dropped. A call on no row at all (a dev registry) is not removed.
 */
function isRemoved(appRowId: string | null, status: string | null): boolean {
  return (
    appRowId !== null && (status === null || status === DELETED_APP_STATUS)
  );
}

/**
 * One page of an organization's tool calls, newest first, with each app's
 * current name and each caller's name as a member of this organization.
 * Names and emails are read through the membership, so a person who has
 * since left shows by id, never by the profile they keep elsewhere, as the
 * usage summary does. Keyset on (organization_id, created_at, id): the
 * `mcp_tool_calls_org_created_idx` index serves the range, and the id
 * breaks ties, so a page is stable across rows with the same timestamp.
 * Never the arguments or the result: the table holds neither.
 */
async function listForOrganization(
  options: ListForOrganizationOptions,
): Promise<ToolCallsPage> {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit) || 1),
    TOOL_CALL_PAGE_MAX,
  );
  const before = options.before
    ? { createdAt: new Date(options.before.createdAt), id: options.before.id }
    : null;
  const rows = await db
    .select({
      id: mcpToolCalls.id,
      createdAt: mcpToolCalls.createdAt,
      userId: mcpToolCalls.userId,
      userName: users.name,
      userEmail: users.email,
      credentialKind: mcpToolCalls.credentialKind,
      clientName: mcpToolCalls.clientName,
      clientInfo: mcpToolCalls.clientInfo,
      appRowId: mcpToolCalls.appRowId,
      appSlug: mcpToolCalls.appSlug,
      appName: apps.name,
      appStatus: apps.status,
      toolName: mcpToolCalls.toolName,
      risk: mcpToolCalls.risk,
      decision: mcpToolCalls.decision,
      reason: mcpToolCalls.reason,
      outcome: mcpToolCalls.outcome,
      durationMs: mcpToolCalls.durationMs,
      resultBytes: mcpToolCalls.resultBytes,
    })
    .from(mcpToolCalls)
    .leftJoin(apps, eq(apps.id, mcpToolCalls.appRowId))
    .leftJoin(
      members,
      and(
        eq(members.userId, mcpToolCalls.userId),
        eq(members.organizationId, mcpToolCalls.organizationId),
      ),
    )
    .leftJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(mcpToolCalls.organizationId, options.organizationId),
        before
          ? or(
              lt(mcpToolCalls.createdAt, before.createdAt),
              and(
                eq(mcpToolCalls.createdAt, before.createdAt),
                lt(mcpToolCalls.id, before.id),
              ),
            )
          : undefined,
        options.appRowId
          ? eq(mcpToolCalls.appRowId, options.appRowId)
          : undefined,
        options.userId ? eq(mcpToolCalls.userId, options.userId) : undefined,
        options.decision
          ? eq(mcpToolCalls.decision, options.decision)
          : undefined,
        options.risk ? eq(mcpToolCalls.risk, options.risk) : undefined,
        options.since ? gte(mcpToolCalls.createdAt, options.since) : undefined,
      ),
    )
    .orderBy(desc(mcpToolCalls.createdAt), desc(mcpToolCalls.id))
    // One row past the page says whether there is a next one.
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    calls: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.getTime(),
      user: { id: row.userId, name: row.userName, email: row.userEmail },
      credential: {
        kind: row.credentialKind,
        clientName: row.clientName,
        clientInfo: row.clientInfo,
      },
      app: {
        rowId: row.appRowId,
        slug: row.appSlug,
        name: row.appName,
        removed: isRemoved(row.appRowId, row.appStatus),
      },
      tool: { name: row.toolName, risk: row.risk },
      decision: row.decision === "allowed" ? "allowed" : "blocked",
      reason: row.reason,
      outcome: row.outcome,
      durationMs: row.durationMs,
      resultBytes: row.resultBytes,
    })),
    nextBefore:
      rows.length > limit && last
        ? { createdAt: last.createdAt.getTime(), id: last.id }
        : null,
  };
}

/**
 * Every app the organization's calls name, once each, with its current
 * name: the App filter's choices. Read from the calls rather than the Apps
 * list so a shared app (whose row is the platform organization's) and a
 * removed app are offered too. One group-by over the organization's rows:
 * `mcp_tool_calls_org_created_idx` narrows the scan to them, but it does
 * not carry `app_row_id`, so each row is read. The retention cron keeps
 * the trail to 90 days and the page keeps the result for a few minutes;
 * if D1 timings still show it, an (organization_id, app_row_id) index is
 * a later additive migration.
 */
async function listAppsWithCalls(
  organizationId: string,
): Promise<ToolCallApp[]> {
  const rows = await db
    .select({
      rowId: mcpToolCalls.appRowId,
      slug: sql<string | null>`max(${mcpToolCalls.appSlug})`,
      name: apps.name,
      status: apps.status,
    })
    .from(mcpToolCalls)
    .leftJoin(apps, eq(apps.id, mcpToolCalls.appRowId))
    .where(
      and(
        eq(mcpToolCalls.organizationId, organizationId),
        isNotNull(mcpToolCalls.appRowId),
      ),
    )
    .groupBy(mcpToolCalls.appRowId, apps.name, apps.status);
  return rows.flatMap((row) =>
    row.rowId === null
      ? []
      : [
          {
            rowId: row.rowId,
            slug: row.slug,
            name: row.name,
            removed: isRemoved(row.rowId, row.status),
          },
        ],
  );
}

/**
 * Delete rows recorded before `cutoff`, in bounded batches; `done` is false
 * when the run stopped with older rows left.
 */
async function deleteRecordedBefore(
  cutoff: Date,
): Promise<{ deleted: number; done: boolean }> {
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const result = await db
      .delete(mcpToolCalls)
      .where(
        inArray(
          mcpToolCalls.id,
          db
            .select({ id: mcpToolCalls.id })
            .from(mcpToolCalls)
            .where(lt(mcpToolCalls.createdAt, cutoff))
            .limit(PRUNE_BATCH_SIZE),
        ),
      )
      .returning({ id: mcpToolCalls.id });
    deleted += result.length;
    if (result.length < PRUNE_BATCH_SIZE) return { deleted, done: true };
  }
  return { deleted, done: false };
}

export const McpToolCallRepository = {
  insert,
  listForOrganization,
  listAppsWithCalls,
  deleteRecordedBefore,
} as const;
