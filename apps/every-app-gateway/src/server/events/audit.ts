/**
 * The audit log (Admin → Activity → Audit, `everyapp_workspace_audit`):
 * the organization's events read back as a trail, newest first, with the
 * catalogue's one-line summary, who did it and what it was about. `ping`
 * and `tool.*` stay out unless a type filter names them: the tool-calls
 * view lists every call. The server function and the workspace tool both
 * read through here, so the two answer the same rows the same way; the
 * CLI reads D1 directly (packages/cli/src/lib/gateway/workspace.ts) and
 * shapes them with the same SDK helpers.
 */
import {
  auditActorOf,
  auditSubjectOf,
  auditTypeCondition,
  auditTypeLabel,
  isAppOwnEventType,
  type AuditActor,
} from "@every-app/sdk/internal";
import { PublicError } from "@/server/errors";
import {
  EventRepository,
  type AuditEventRow,
} from "@/server/repositories/EventRepository";
import type {
  AuditActorChoice,
  AuditCursor,
  AuditPage,
  AuditRow,
} from "@/types/audit";
import { summarize } from "./catalogue";

/** A type, or a prefix with `.*`, or `*`; what the filter accepts. */
export const AUDIT_TYPE_FILTER_PATTERN =
  /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/;
export const AUDIT_TYPE_FILTER_MAX = 80;
export const AUDIT_LIMIT_DEFAULT = 50;

interface AuditFilters {
  limit?: number | undefined;
  before?: AuditCursor | undefined;
  actorId?: string | undefined;
  /** An exact type, a prefix like `member.*`, or `*` for everything. */
  type?: string | undefined;
  since?: Date | undefined;
}

function parsed(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** The actor as the surfaces show it: the column, the users row, the JSON, in that order. */
function actorOf(row: AuditEventRow): AuditActor {
  const stored = auditActorOf(row.actor);
  const kind = row.actorKind ?? stored.kind;
  const id = row.actorId ?? stored.id;
  if (kind === "user") {
    return {
      kind,
      id,
      email: row.userEmail ?? stored.email,
      name: row.userName ?? stored.name,
    };
  }
  return { kind, id, email: stored.email, name: stored.name };
}

/** One row as every reader shows it. */
function auditRowOf(row: AuditEventRow): AuditRow {
  const data = parsed(row.data) as Record<string, unknown>;
  const actor = actorOf(row);
  return {
    id: row.id,
    time: row.time.getTime(),
    type: row.type,
    label: auditTypeLabel(row.type),
    summary: summarize(row.type, data, { ...actor }),
    actor,
    subject: auditSubjectOf(row.type, data),
    appEvent: isAppOwnEventType(row.type),
  };
}

/** The type filter as the repository takes it; refused when it isn't a type or pattern. */
function auditTypeFilter(
  type: string | undefined,
): { op: "eq" | "prefix"; value: string } | null | undefined {
  if (type === undefined) return undefined;
  const value = type.trim();
  if (
    value.length === 0 ||
    value.length > AUDIT_TYPE_FILTER_MAX ||
    !AUDIT_TYPE_FILTER_PATTERN.test(value)
  ) {
    throw new PublicError(
      "INVALID_INPUT",
      `type is an event type (member.joined), a prefix (member.*, app.crm.*) or *`,
    );
  }
  return auditTypeCondition(value);
}

/** One page of the organization's audit log. */
export async function listAudit(
  organizationId: string,
  filters: AuditFilters,
): Promise<AuditPage> {
  const limit = filters.limit ?? AUDIT_LIMIT_DEFAULT;
  const { rows, more } = await EventRepository.listForAudit({
    organizationId,
    limit,
    before: filters.before,
    actorId: filters.actorId,
    type: auditTypeFilter(filters.type),
    since: filters.since,
  });
  const events = rows.map(auditRowOf);
  const last = events.at(-1);
  return {
    events,
    nextBefore: more && last ? { time: last.time, id: last.id } : null,
  };
}

/** Whom the organization's audit log names, most active first. */
export async function listAuditActors(
  organizationId: string,
): Promise<AuditActorChoice[]> {
  const rows = await EventRepository.listAuditActors(organizationId);
  return rows
    .map((row) => ({
      ...actorOf({
        id: "",
        time: new Date(0),
        type: "",
        data: "{}",
        actor: row.actor,
        actorKind: row.actorKind,
        actorId: row.actorId,
        userEmail: row.userEmail,
        userName: row.userName,
      }),
      events: Number(row.events),
    }))
    .sort((a, b) => b.events - a.events);
}
