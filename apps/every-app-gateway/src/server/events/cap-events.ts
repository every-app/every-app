/**
 * The cap events (docs/design/2026-10-events-out.md, section 5): from a
 * monthly cap check's standing (app-cap.ts), for each cap that binds (the
 * call cap and the dollar cap, each on its own), `cap.warning` once the
 * month's use reaches 80% of it, and `cap.reached` with `app.paused_cap`
 * once it reaches it; `data.kind` says which (`calls` or `cost`). The
 * AppGateway entrypoint and the provider-app call path both check the
 * caps, so both call this under `waitUntil`, after their answer. Each
 * event's dedupe key is per organization, app row, month, kind and cap,
 * so a cap that is hit a thousand times in a month is announced once,
 * from whichever isolate gets there first; a raised cap starts the count
 * over, as its key changes. The keys this isolate emitted lately are
 * remembered, so a paused app an agent keeps retrying costs no
 * subscriptions read and no no-op batch per 429.
 */
import type { CapStanding, MonthlyCapCheck } from "@/server/app-cap";
import { emit } from "./bus";
import {
  CAP_WARNING_THRESHOLD,
  capKey,
  catalogue,
  type BuiltEvent,
  type CapInput,
} from "./catalogue";
import { appSubject, GATEWAY_ACTOR } from "./subjects";

/** How long an emitted key is remembered; bounded like the subject caches. */
const RECENT_TTL_MS = 30_000;
const RECENT_MAX_ENTRIES = 500;
const recent = new Map<string, number>();

export function clearCapEventMemoryForTests(): void {
  recent.clear();
}

function remembered(key: string, now: number): boolean {
  const until = recent.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  recent.delete(key);
  return false;
}

function remember(key: string, now: number): void {
  recent.set(key, now + RECENT_TTL_MS);
  if (recent.size > RECENT_MAX_ENTRIES) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
}

/** The events one cap's standing calls for: none below 80%. */
function dueFor(
  organizationId: string,
  appRowId: string,
  month: string,
  standing: CapStanding,
): Array<{ key: string; build: (input: CapInput) => BuiltEvent }> {
  const { kind, cap, used } = standing;
  const key = (type: string, threshold?: number) =>
    capKey(type, organizationId, appRowId, month, kind, cap, threshold);
  if (used >= cap) {
    return [
      {
        key: key("cap.reached"),
        build: (input) => catalogue.capReached(input),
      },
      {
        key: key("app.paused_cap"),
        build: (input) => catalogue.appPausedCap(input),
      },
    ];
  }
  if (used < Math.ceil((cap * CAP_WARNING_THRESHOLD) / 100)) return [];
  return [
    {
      key: key("cap.warning", CAP_WARNING_THRESHOLD),
      build: (input) => catalogue.capWarning(input),
    },
  ];
}

/** Emit whatever this check's standing calls for; nothing without a cap. */
export async function noteCapCheck(
  organizationId: string,
  appRowId: string,
  check: MonthlyCapCheck,
): Promise<void> {
  if (check.caps === undefined) return;
  const { month, calls, costMicros } = check;
  const now = Date.now();
  for (const standing of check.caps) {
    const due = dueFor(organizationId, appRowId, month, standing).filter(
      ({ key }) => !remembered(key, now),
    );
    for (const { key, build } of due) {
      await emit(async () => ({
        organizationId,
        actor: GATEWAY_ACTOR,
        ...build({
          organizationId,
          app: await appSubject(appRowId),
          kind: standing.kind,
          cap: standing.cap,
          source: standing.source,
          calls,
          costMicros,
          month,
        }),
      }));
      remember(key, now);
    }
  }
}
