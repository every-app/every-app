import { inArray, lt } from "drizzle-orm";
import type { ToolCallAuditEvent } from "@every-app/toolbus";
import { db } from "@/db";
import { mcpToolCalls } from "@/db/schema";

/** Rows deleted per statement when pruning, so one prune never runs long. */
const PRUNE_BATCH_SIZE = 1000;
/**
 * Statements per prune run (the hourly cron's): 20,000 rows an hour, and
 * well inside D1's 50 queries per invocation on the free plan. Whatever is
 * left goes on the next run.
 */
const PRUNE_MAX_BATCHES = 20;

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
  deleteRecordedBefore,
} as const;
