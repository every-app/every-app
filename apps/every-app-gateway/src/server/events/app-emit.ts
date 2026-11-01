/**
 * Apps emit their own events (docs/design/2026-10-events-out.md, section
 * 7): `POST /api/events/emit` over the EVERY_APP_GATEWAY binding, the
 * AppGateway entrypoint's third route kind. The entrypoint attributes the
 * call as it does for every capability (the request's identity, or a
 * shared app's named organization); this module checks the event's name
 * and data by the shared rules (@every-app/sdk/internal), counts the
 * app's emits against its hourly rate, and puts the event on the bus as
 * `app.<app id>.<name>`. Not a provider call: not counted in usage, not
 * capped by the monthly cap. The counter and the bus are injectable so
 * the entrypoint's tests run with fakes.
 */
import {
  APP_EVENT_RATE_PER_HOUR,
  APP_EVENT_DATA_MAX_BYTES,
  appEventNameProblem,
  appEventType,
  checkEventData,
  type EveryAppUser,
} from "@every-app/sdk/internal";
import type { RegisteredApp } from "@every-app/perimeter";
import { readCapped } from "@/server/capabilities/read-capped";
import { capabilityRefusal } from "@/server/capabilities/refusal";
import type { EmitInput, QueuedEvent } from "./bus";

export interface AppEmitDeps {
  /**
   * Count one emit for the app in the hour `now` is in: whether it is
   * within the rate, and when the window ends if not.
   */
  countEmit(
    appKey: string,
    now: Date,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  /** Put the event on the bus; throws when the write fails. */
  emit(input: EmitInput): Promise<QueuedEvent | null>;
}

const HOUR_MS = 60 * 60 * 1000;
/**
 * The most a request body may be, read before it is parsed: the data's
 * own limit twice over, room for the event name, the envelope and the
 * whitespace of a pretty-printed body. The 8 KiB rule is checked on the
 * serialized data afterwards.
 */
const APP_EVENT_BODY_MAX_BYTES = APP_EVENT_DATA_MAX_BYTES * 2;

/** The Worker's counter table and bus, loaded on first use (they read D1). */
export async function loadAppEmitDeps(): Promise<AppEmitDeps> {
  const [{ RateLimitCounterRepository }, { emitNow }, { userActor }] =
    await Promise.all([
      import("@/server/repositories/RateLimitCounterRepository"),
      import("./bus"),
      import("./subjects"),
    ]);
  return {
    countEmit: async (appKey, now) => {
      const hour = now.toISOString().slice(0, 13);
      const key = `events:emit:${appKey}:${hour}`;
      const windowEnd = new Date(Date.parse(`${hour}:00:00.000Z`) + HOUR_MS);
      // One statement decides: concurrent emits at the limit each see
      // their own count, so exactly the allowed number pass.
      const count = await RateLimitCounterRepository.incrementReturning(
        key,
        windowEnd,
      );
      if (count > APP_EVENT_RATE_PER_HOUR) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((windowEnd.getTime() - now.getTime()) / 1000),
          ),
        };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
    emit: async (input) =>
      emitNow({
        ...input,
        // The identity carries the id and address; the name is looked up,
        // and the identity stands when the lookup can't be made.
        actor:
          input.actor.kind === "user"
            ? await userActor(input.actor.id).catch(() => input.actor)
            : input.actor,
      }),
  };
}

interface AppEmitCall {
  request: Request;
  app: RegisteredApp;
  organizationId: string;
  user: EveryAppUser | null;
}

/** Serve one emit: the refusals of section 7, or 202 with the event's id and type. */
export async function handleAppEmit(
  call: AppEmitCall,
  deps: AppEmitDeps,
  now = new Date(),
): Promise<Response> {
  const { request, app } = call;
  if (request.method !== "POST") {
    return capabilityRefusal(
      405,
      "method_not_allowed",
      "Emit an event with POST.",
    );
  }
  // Bounded before it is parsed: the data rule below needs the whole
  // body serialized, so the reader stops at the cap instead.
  const text = await readCapped(request, APP_EVENT_BODY_MAX_BYTES);
  if (text === null) {
    return capabilityRefusal(
      413,
      "event_data_too_large",
      `An event's request body is at most ${APP_EVENT_BODY_MAX_BYTES / 1024} KiB.`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return capabilityRefusal(
      400,
      "event_data_invalid",
      "Send JSON: { event, data }.",
    );
  }
  const message =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { event?: unknown; data?: unknown })
      : {};
  const nameProblem = appEventNameProblem(message.event);
  if (nameProblem) {
    return capabilityRefusal(400, "event_name_invalid", nameProblem);
  }
  // Absent or null data is an empty object: what is checked is what is
  // emitted, so the bus never sees a shape the check didn't.
  const data = message.data ?? {};
  const check = checkEventData(data, APP_EVENT_DATA_MAX_BYTES);
  if (!check.ok) {
    return capabilityRefusal(
      check.code === "event_data_too_large" ? 413 : 400,
      check.code,
      check.message,
    );
  }
  const rate = await deps.countEmit(app.rowId ?? app.appId, now);
  if (!rate.allowed) {
    return capabilityRefusal(
      429,
      "event_rate_limited",
      `${app.appId} has emitted ${APP_EVENT_RATE_PER_HOUR.toLocaleString("en-US")} events this hour, which is the most an app may.`,
      { "retry-after": String(rate.retryAfterSeconds) },
    );
  }
  const type = appEventType(app.appId, message.event as string);
  const queued = await deps.emit({
    organizationId: call.organizationId,
    actor: call.user
      ? { kind: "user", id: call.user.id, email: call.user.email }
      : { kind: "app", id: app.appId },
    type,
    version: 1,
    data: data as Record<string, unknown>,
    ...(app.rowId ? { appRowId: app.rowId } : {}),
    time: now,
  });
  return Response.json(
    { id: queued?.id ?? null, type },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
