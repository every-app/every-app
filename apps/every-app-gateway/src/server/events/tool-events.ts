/**
 * The tool events (docs/design/2026-10-events-out.md, section 5):
 * `tool.blocked` and `tool.error` from the ToolBus's audit of every tool
 * call (toolbus/runtime.ts), riding the same waitUntil as the audit row,
 * and `app.tools_changed` from the catalog sync (toolbus/catalog-sync.ts)
 * when the stored tool names differ from the snapshot before. Like the
 * audit table, the events carry the tool's name, the outcome and the
 * client, never the arguments or the result.
 */
import type { ToolCallAuditEvent } from "@every-app/toolbus";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { emit } from "./bus";
import { catalogue, type EventActor } from "./catalogue";
import { appSubject, GATEWAY_ACTOR, userSubject } from "./subjects";

/** Whether the audit of this call is an event at all. */
export function toolCallIsEvent(event: ToolCallAuditEvent): boolean {
  return event.decision === "blocked" || event.outcome !== "ok";
}

/** Emit tool.blocked or tool.error for an audited call, as its decision says. */
export async function announceToolCall(
  event: ToolCallAuditEvent,
): Promise<void> {
  if (!toolCallIsEvent(event)) return;
  const client = {
    kind: event.credentialKind,
    ...(event.clientName ? { name: event.clientName } : {}),
    id: event.credentialId,
  };
  const actor: EventActor = {
    kind: "agent",
    id: event.credentialId,
    ...(event.clientName ? { name: event.clientName } : {}),
  };
  await emit(async () => {
    const [user, app] = await Promise.all([
      userSubject(event.userId),
      event.appRowId ? appSubject(event.appRowId) : Promise.resolve(undefined),
    ]);
    const common = {
      tool: event.tool,
      ...(app ? { app } : {}),
      user,
      client,
      ...(event.risk ? { risk: event.risk } : {}),
      callId: event.callId,
    };
    return {
      organizationId: event.organizationId,
      actor,
      ...(event.decision === "blocked"
        ? catalogue.toolBlocked({
            ...common,
            reason: event.reason ?? "blocked",
          })
        : catalogue.toolError({
            ...common,
            outcome: event.outcome,
            durationMs: event.durationMs,
          })),
    };
  });
}

/** Emit app.tools_changed when a sync stored a different set of tool names. */
export async function announceToolsChanged(input: {
  app: { rowId: string; organizationId: string; tier: string };
  /** Said by the caller for a remote MCP app; else from the tier. */
  kind?: "app" | "builtin" | "remote";
  previous: readonly string[];
  current: readonly string[];
}): Promise<void> {
  const before = new Set(input.previous);
  const after = new Set(input.current);
  const added = [...after].filter((name) => !before.has(name)).sort();
  const removed = [...before].filter((name) => !after.has(name)).sort();
  if (added.length === 0 && removed.length === 0) return;
  await emit(async () => ({
    organizationId: input.app.organizationId,
    actor: GATEWAY_ACTOR,
    ...catalogue.appToolsChanged({
      app: await appSubject(input.app.rowId),
      kind:
        input.kind ??
        (input.app.tier === PROVIDER_APP_TIER ? "builtin" : "app"),
      toolCount: after.size,
      previousToolCount: before.size,
      added,
      removed,
    }),
  }));
}
