/**
 * The cap events (docs/design/2026-10-events-out.md, section 5): from a
 * monthly cap check's standing (app-cap.ts), `cap.warning` once the
 * month's calls reach 80% of the cap, and `cap.reached` with
 * `app.paused_cap` once they reach it. The AppGateway entrypoint and the
 * provider-app call path both check the cap, so both call this under
 * `waitUntil`, after their answer. Each event's dedupe key is per
 * organization, app row, month and cap, so a cap that is hit a thousand
 * times in a month is announced once, from whichever isolate gets there
 * first; a raised cap starts the count over, as its key changes. The keys
 * this isolate emitted lately are remembered, so a paused app an agent
 * keeps retrying costs no subscriptions read and no no-op batch per 429.
 */
import type { MonthlyCapCheck } from "@/server/app-cap";
import { emit } from "./bus";
import {
  CAP_WARNING_THRESHOLD,
  capKey,
  catalogue,
  type BuiltEvent,
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

/** Emit whatever this check's standing calls for; nothing without a cap. */
export async function noteCapCheck(
  organizationId: string,
  appRowId: string,
  check: MonthlyCapCheck,
): Promise<void> {
  if (check.cap === undefined) return;
  const warningAt = Math.ceil((check.cap * CAP_WARNING_THRESHOLD) / 100);
  if (!check.exceeded && check.calls < warningAt) return;
  const { cap, month } = check;
  const standing = async () => ({
    organizationId,
    app: await appSubject(appRowId),
    cap,
    calls: check.calls,
    month,
    source: check.source,
  });
  type Standing = Awaited<ReturnType<typeof standing>>;
  const due: Array<{ key: string; build: (input: Standing) => BuiltEvent }> =
    check.exceeded
      ? [
          {
            key: capKey("cap.reached", organizationId, appRowId, month, cap),
            build: (input) => catalogue.capReached(input),
          },
          {
            key: capKey("app.paused_cap", organizationId, appRowId, month, cap),
            build: (input) => catalogue.appPausedCap(input),
          },
        ]
      : [
          {
            key: capKey(
              "cap.warning",
              organizationId,
              appRowId,
              month,
              cap,
              CAP_WARNING_THRESHOLD,
            ),
            build: (input) => catalogue.capWarning(input),
          },
        ];
  const now = Date.now();
  for (const { key, build } of due) {
    if (remembered(key, now)) continue;
    await emit(async () => ({
      organizationId,
      actor: GATEWAY_ACTOR,
      ...build(await standing()),
    }));
    remember(key, now);
  }
}
