/**
 * Delivery (docs/design/2026-10-events-out.md, section 4). `deliverOnce`
 * makes one attempt at one delivery row: claim it (one conditional
 * UPDATE, so no other isolate sends the same attempt), load the event and
 * the subscription, build the envelope, send it through the webhook sink
 * (a signed POST that follows no redirect, times out at ten seconds and
 * reads at most a kilobyte of the answer) or the email sink, then settle
 * the row: delivered, pending again with the next backoff, or dead after
 * the seventh failure, a 410, or a refusal no retry can fix. `sweep` is
 * what the per-minute cron runs: up to 50 due rows, six at a time, within
 * a wall-clock budget. The fetch, the mail and the clock are injectable so
 * tests use fakes and the Worker uses the real ones.
 */
import { env } from "cloudflare:workers";
import {
  EVENT_DELIVERY_MAX_ATTEMPTS,
  EVENT_DELIVERY_TIMEOUT_MS,
  EVENT_HEADERS,
  EVENT_RESPONSE_KEEP_CHARS,
  EVENT_RESPONSE_READ_MAX_BYTES,
  EVENT_RETRY_DELAYS_MS,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import { gatewayHosts } from "@/server/gateway-hosts";
import {
  EventDeliveryRepository,
  type DeliveryRow,
} from "@/server/repositories/EventDeliveryRepository";
import { EventRepository } from "@/server/repositories/EventRepository";
import {
  EventSubscriptionRepository,
  type SubscriptionRow,
} from "@/server/repositories/EventSubscriptionRepository";
import { summarize } from "./catalogue";
import { sendEventEmail, type EventMailer } from "./email-sink";
import { eventSignatureHeader } from "./signing";
import type { SinkResult } from "./sink-result";
import { organizationSubject } from "./subjects";
import { checkTarget, targetRulesFromEnv, type TargetRules } from "./target";

/** How long a claim holds a row: longer than the slowest attempt. */
const CLAIM_HOLD_MS = 60_000;
/** The sweep's bounds: rows a run, attempts in flight, wall clock. */
const SWEEP_BATCH = 50;
const SWEEP_CONCURRENCY = 6;
const SWEEP_BUDGET_MS = 25_000;

export interface DeliveryDeps {
  fetch: typeof fetch;
  mailer: () => Promise<EventMailer>;
  now: () => Date;
  gatewayUrl: () => string;
  userAgent: () => string;
  targetRules: () => TargetRules;
}

interface DeliveryEnv {
  GATEWAY_URL?: string;
  APP_BASE_DOMAIN?: string;
  THIRD_PARTY_DOMAIN?: string;
  EVENTS_ALLOW_PRIVATE_TARGETS?: string;
  EVERYAPP_RELEASE?: { version?: string };
}

let depsForTests: DeliveryDeps | undefined;

/** Tests stand in for the fetch, the mail and the clock; `undefined` restores them. */
export function setDeliveryDepsForTests(deps: DeliveryDeps | undefined): void {
  depsForTests = deps;
}

/** The Worker's own fetch, mail, clock and settings. */
function defaultDeliveryDeps(): DeliveryDeps {
  if (depsForTests) return depsForTests;
  const settings = env as unknown as DeliveryEnv;
  return {
    fetch: (input, init) => fetch(input, init),
    mailer: async () => {
      const mail = await import("@/server/email/sendEmail");
      return {
        isConfigured: mail.isEmailConfigured,
        send: mail.sendEmail,
        recipientHash: mail.recipientKey,
      };
    },
    now: () => new Date(),
    gatewayUrl: () => settings.GATEWAY_URL ?? "",
    userAgent: () =>
      `every-app-gateway/${settings.EVERYAPP_RELEASE?.version ?? "dev"}`,
    targetRules: () => targetRulesFromEnv(settings, gatewayHosts(settings)),
  };
}

type DeliveryOutcome = "delivered" | "failed" | "dead" | "skipped";

/** The envelope a receiver gets (section 2). */
interface EventEnvelope {
  id: string;
  type: string;
  version: number;
  summary: string;
  time: string;
  gateway: string;
  organization: { id: string; slug: string; name: string };
  actor: unknown;
  data: Record<string, unknown>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Up to `maxBytes` of a response body, as text; cancels the rest. */
async function readHead(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(Math.min(bytes, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const room = joined.length - offset;
    if (room <= 0) break;
    joined.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  return new TextDecoder().decode(joined);
}

/** `<code>: <the start of the answer>`, on one line, bounded. */
function describeAnswer(code: string, answer: string): string {
  const excerpt = answer
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EVENT_RESPONSE_KEEP_CHARS);
  return excerpt ? `${code}: ${excerpt}` : code;
}

async function sendWebhook(
  subscription: SubscriptionRow,
  envelope: EventEnvelope,
  delivery: DeliveryRow,
  deps: DeliveryDeps,
): Promise<SinkResult> {
  if (!subscription.url || !subscription.secret) {
    return {
      ok: false,
      statusCode: null,
      error: "subscription_gone",
      dead: true,
    };
  }
  // Checked again: the setting or the gateway's hosts may have changed
  // since the subscription was added.
  const target = checkTarget(subscription.url, deps.targetRules());
  if (!target.ok) {
    return {
      ok: false,
      statusCode: null,
      error: `target_refused: ${target.reason}`,
      dead: false,
    };
  }
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(deps.now().getTime() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": deps.userAgent(),
    [EVENT_HEADERS.event]: envelope.type,
    [EVENT_HEADERS.eventId]: envelope.id,
    [EVENT_HEADERS.delivery]: delivery.id,
    [EVENT_HEADERS.attempt]: String(delivery.attempts),
    [EVENT_HEADERS.signature]: await eventSignatureHeader(
      subscription.secret,
      timestamp,
      body,
    ),
  };
  let response: Response;
  try {
    response = await deps.fetch(subscription.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(EVENT_DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, statusCode: null, error: "timeout", dead: false };
    }
    return {
      ok: false,
      statusCode: null,
      error: describeAnswer(
        "connection",
        error instanceof Error ? error.message : String(error),
      ),
      dead: false,
    };
  }
  const status = response.status;
  if (status >= 200 && status < 300) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: true, statusCode: status };
  }
  const answer = await readHead(response, EVENT_RESPONSE_READ_MAX_BYTES).catch(
    () => "",
  );
  if (status >= 300 && status < 400) {
    // Never followed: the body would go wherever the target pointed.
    return { ok: false, statusCode: status, error: "redirect", dead: false };
  }
  return {
    ok: false,
    statusCode: status,
    error: describeAnswer(`status_${status}`, answer),
    // Gone: the receiver says never again.
    dead: status === 410,
  };
}

/** The wait before attempt n + 1, after attempt n failed (n from 1). */
function backoffAfter(attempt: number): number | null {
  if (attempt >= EVENT_DELIVERY_MAX_ATTEMPTS) return null;
  return EVENT_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

async function settle(
  delivery: DeliveryRow,
  result: SinkResult,
  deps: DeliveryDeps,
): Promise<DeliveryOutcome> {
  const now = deps.now();
  let outcome: DeliveryOutcome;
  if (result.ok) {
    await EventDeliveryRepository.markDelivered(delivery.id, {
      at: now,
      statusCode: result.statusCode,
    });
    outcome = "delivered";
  } else {
    const wait = result.dead ? null : backoffAfter(delivery.attempts);
    if (wait === null) {
      await EventDeliveryRepository.markDead(delivery.id, {
        statusCode: result.statusCode,
        error: result.error,
      });
      outcome = "dead";
    } else {
      await EventDeliveryRepository.markRetry(delivery.id, {
        nextAttemptAt: new Date(now.getTime() + wait),
        statusCode: result.statusCode,
        error: result.error,
      });
      outcome = "failed";
    }
  }
  await EventSubscriptionRepository.recordAttempt(delivery.subscriptionId, {
    at: now,
    status: outcome,
  });
  logEvent(
    "events.delivery",
    {
      delivery: delivery.id,
      event: delivery.eventId,
      subscription: delivery.subscriptionId,
      org: delivery.organizationId,
      attempt: delivery.attempts,
      outcome,
      status_code: result.statusCode,
      ...(result.ok ? {} : { error: result.error.slice(0, 80) }),
    },
    outcome === "delivered" ? "log" : "warn",
  );
  return outcome;
}

/** The envelope for a stored event, as every sink sends it. */
async function buildEnvelope(
  event: NonNullable<Awaited<ReturnType<typeof EventRepository.findById>>>,
  deps: DeliveryDeps,
): Promise<EventEnvelope> {
  const organization = await organizationSubject(event.organizationId);
  const actor = parseJson(event.actor);
  const data = parseJson(event.data);
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return {
    id: event.id,
    type: event.type,
    version: event.version,
    summary: summarize(event.type, payload, actor as never),
    time: event.time.toISOString(),
    gateway: deps.gatewayUrl(),
    organization: {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
    },
    actor,
    data: payload,
  };
}

/** One attempt at one delivery; `skipped` when another worker holds it. */
export async function deliverOnce(
  deliveryId: string,
  deps: DeliveryDeps = defaultDeliveryDeps(),
): Promise<DeliveryOutcome> {
  const claimed = await EventDeliveryRepository.claim(
    deliveryId,
    deps.now(),
    CLAIM_HOLD_MS,
  );
  if (!claimed) return "skipped";
  const event = await EventRepository.findById(
    claimed.eventId,
    claimed.organizationId,
  );
  if (!event) {
    return settle(
      claimed,
      { ok: false, statusCode: null, error: "event_gone", dead: true },
      deps,
    );
  }
  const subscription = await EventSubscriptionRepository.findForDelivery(
    claimed.subscriptionId,
    claimed.organizationId,
  );
  // A ping reaches a paused subscription: that is what a test is for.
  if (!subscription || (!subscription.enabled && event.type !== "ping")) {
    return settle(
      claimed,
      { ok: false, statusCode: null, error: "subscription_gone", dead: true },
      deps,
    );
  }
  let result: SinkResult;
  try {
    const envelope = await buildEnvelope(event, deps);
    result =
      subscription.sink === "email"
        ? await sendEventEmail(
            {
              organizationId: event.organizationId,
              organizationName: envelope.organization.name,
              recipients:
                subscription.recipients === "owners" ? "owners" : "admins",
              type: event.type,
              summary: envelope.summary,
              data: envelope.data,
              gatewayUrl: deps.gatewayUrl(),
              deliveryId: claimed.id,
            },
            await deps.mailer(),
          )
        : await sendWebhook(subscription, envelope, claimed, deps);
  } catch (error) {
    result = {
      ok: false,
      statusCode: null,
      error: describeAnswer(
        "internal",
        error instanceof Error ? error.message : String(error),
      ),
      dead: false,
    };
  }
  return settle(claimed, result, deps);
}

/** Attempt these deliveries now, a few at a time; failures are logged, never thrown. */
export async function attemptDeliveries(
  deliveryIds: readonly string[],
  deps: DeliveryDeps = defaultDeliveryDeps(),
  concurrency = SWEEP_CONCURRENCY,
): Promise<Record<DeliveryOutcome, number>> {
  const counts: Record<DeliveryOutcome, number> = {
    delivered: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
  };
  const queue = [...deliveryIds];
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          counts[await deliverOnce(id, deps)] += 1;
        } catch (error) {
          logEvent(
            "events.delivery_failed",
            {
              delivery: id,
              message: error instanceof Error ? error.message : String(error),
            },
            "error",
          );
        }
      }
    },
  );
  await Promise.all(workers);
  return counts;
}

/**
 * The cron's pass: due rows, soonest first, attempted a few at a time
 * until the batch is done or the budget is spent (the rest waits a
 * minute). Returns what happened, for the log line.
 */
export async function sweep(
  deps: DeliveryDeps = defaultDeliveryDeps(),
  options: { budgetMs?: number; batch?: number } = {},
): Promise<Record<DeliveryOutcome, number> & { due: number }> {
  const started = Date.now();
  const budget = options.budgetMs ?? SWEEP_BUDGET_MS;
  const due = await EventDeliveryRepository.findDue(
    deps.now(),
    options.batch ?? SWEEP_BATCH,
  );
  const counts: Record<DeliveryOutcome, number> = {
    delivered: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
  };
  const queue = [...due];
  const workers = Array.from(
    { length: Math.min(SWEEP_CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0 && Date.now() - started < budget) {
        const id = queue.shift();
        if (id === undefined) break;
        try {
          counts[await deliverOnce(id, deps)] += 1;
        } catch (error) {
          logEvent(
            "events.delivery_failed",
            {
              delivery: id,
              message: error instanceof Error ? error.message : String(error),
            },
            "error",
          );
        }
      }
    },
  );
  await Promise.all(workers);
  return { ...counts, due: due.length };
}
