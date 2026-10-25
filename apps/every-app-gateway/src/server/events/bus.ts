/**
 * The event bus (docs/design/2026-10-events-out.md, section 5): `emit`
 * takes a built event (catalogue.ts) with whose organization it is and
 * who caused it, reads the organization's subscriptions once, writes the
 * event row and one delivery row per matching subscription in one D1
 * batch (honouring the dedupe key: a collision writes nothing), and
 * queues the first attempts under `waitUntil`. It never throws to the
 * caller: a webhook must never break the action that caused it, so an
 * emit that fails is logged as `events.emit_failed` and swallowed. An
 * emit point that still has to look its subjects up (a member's name, an
 * app's) passes a builder instead of the input, so a lookup that fails
 * is swallowed the same way rather than failing the action after it
 * happened.
 *
 * `emitAndWait` is for tests and the subscription test: it attempts the
 * queued deliveries before returning. Hot paths (a cap check on a provider
 * call) run the whole emit under their own waitUntil.
 */
import { waitUntil } from "cloudflare:workers";
import {
  checkEventData,
  eventSubscribed,
  EVENT_DATA_MAX_BYTES,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import { EventRepository } from "@/server/repositories/EventRepository";
import {
  EventSubscriptionRepository,
  type ListedSubscription,
} from "@/server/repositories/EventSubscriptionRepository";
import type { BuiltEvent, EventActor } from "./catalogue";
import { attemptDeliveries } from "./deliver";
import { newDeliveryId, newEventId } from "./ids";

export interface EmitInput extends BuiltEvent {
  organizationId: string;
  actor: EventActor;
  /** Deliver to this one subscription only, enabled or not (a ping). */
  only?: string;
  /** When it happened; now by default. */
  time?: Date;
}

export interface QueuedEvent {
  id: string;
  deliveryIds: string[];
}

/** A subscription's patterns, as stored: a JSON list, or everything. */
export function subscriptionPatterns(
  subscription: Pick<ListedSubscription, "events">,
): string[] {
  try {
    const parsed = JSON.parse(subscription.events) as unknown;
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
      return parsed.length > 0 ? parsed : ["*"];
    }
  } catch {
    // Not a list: treated as everything, below.
  }
  return ["*"];
}

function matches(subscription: ListedSubscription, input: EmitInput): boolean {
  if (input.only !== undefined) return subscription.id === input.only;
  return (
    subscription.enabled &&
    eventSubscribed(subscriptionPatterns(subscription), input.type)
  );
}

/**
 * Write the event and its deliveries; null when the dedupe key collided
 * (already emitted) and nothing was written. Throws on a write failure.
 */
export async function queueEvent(
  input: EmitInput,
): Promise<QueuedEvent | null> {
  const check = checkEventData(input.data, EVENT_DATA_MAX_BYTES);
  if (!check.ok) {
    throw new Error(`event ${input.type} refused: ${check.message}`);
  }
  const now = input.time ?? new Date();
  const id = newEventId(now);
  const subscriptions = await EventSubscriptionRepository.listByOrganization(
    input.organizationId,
  );
  const deliveries = subscriptions
    .filter((subscription) => matches(subscription, input))
    .map((subscription) => ({
      id: newDeliveryId(),
      eventId: id,
      subscriptionId: subscription.id,
      organizationId: input.organizationId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    }));
  const result = await EventRepository.insertWithDeliveries(
    {
      id,
      organizationId: input.organizationId,
      type: input.type,
      version: input.version,
      time: now,
      actor: JSON.stringify(input.actor),
      data: JSON.stringify(input.data),
      appRowId: input.appRowId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
    },
    deliveries,
  );
  if (!result.inserted) return null;
  logEvent("events.emitted", {
    event: id,
    type: input.type,
    org: input.organizationId,
    deliveries: result.deliveryIds.length,
  });
  return { id, deliveryIds: result.deliveryIds };
}

function logFailure(input: EmitInput | undefined, error: unknown): void {
  logEvent(
    "events.emit_failed",
    {
      // Unbuilt: the builder itself failed (a subject lookup).
      type: input?.type ?? "unbuilt",
      org: input?.organizationId ?? null,
      message: error instanceof Error ? error.message : String(error),
    },
    "error",
  );
}

/**
 * Emit an event and return it: the rows are written before this resolves,
 * the first delivery attempts run after the response. Throws when the
 * write fails; the app emit route answers that, everything else uses
 * {@link emit}.
 */
export async function emitNow(input: EmitInput): Promise<QueuedEvent | null> {
  const queued = await queueEvent(input);
  if (queued && queued.deliveryIds.length > 0) {
    waitUntil(attemptDeliveries(queued.deliveryIds));
  }
  return queued;
}

/**
 * Emit an event, given or built here; a builder or a write that fails is
 * logged and swallowed. Never throws.
 */
export async function emit(
  input: EmitInput | (() => Promise<EmitInput>),
): Promise<void> {
  let built: EmitInput | undefined;
  try {
    built = typeof input === "function" ? await input() : input;
    await emitNow(built);
  } catch (error) {
    logFailure(built, error);
  }
}

/**
 * Emit and attempt every queued delivery before returning: the
 * subscription test (which reports the outcome) and the tests use it.
 */
export async function emitAndWait(
  input: EmitInput,
): Promise<QueuedEvent | null> {
  const queued = await queueEvent(input);
  if (queued && queued.deliveryIds.length > 0) {
    await attemptDeliveries(queued.deliveryIds);
  }
  return queued;
}
