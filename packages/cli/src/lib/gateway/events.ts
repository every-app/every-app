/**
 * The event bus's rows the CLI still writes into the Gateway's D1, for the
 * writes it still makes itself (ADR-0003, "What the CLI writes"): the
 * deploy path (`app.installed`, `app.updated`, `app.removed`,
 * `app.email_changed`) and the Worker-secret commands (`secret`, `signin`,
 * `access`, `provider`, `mcp`), whose changes have no Gateway service to
 * go through. Everything the Gateway's tools do (`workspace`, `events`,
 * `ai`) records its own events.
 *
 *  - The outbox (`queueEventFromCli`): the `events` row and one pending
 *    `event_deliveries` row per matching subscription, as statements the
 *    calling command adds to its own D1 batch, so an `app.installed` is
 *    queued atomically with the registration it reports. The Gateway's
 *    per-minute sweep delivers them; the CLI never calls a receiver.
 *  - An app's own `app` subscription, kept in step with its manifest's
 *    `events` by the deploy.
 *
 * The rows hold what the Gateway's bus writes and nothing more: the
 * Gateway builds the envelope (organization, gateway URL, the catalogue's
 * summary) from them at delivery time.
 */
import {
  APP_SINK_PATTERNS_MAX,
  appSinkPatternProblem,
  appSinkTypeAllowed,
  checkEventData,
  EVENT_DATA_MAX_BYTES,
  EVENT_SUBSCRIPTION_NAME_MAX,
  eventSubscribed,
  eventTypeInfo,
} from "@every-app/sdk/internal";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { deliveryId, eventId, subscriptionId } from "./eventIds";
import type { Deployer } from "./registry";

type D1Value = string | number | null;

/** Who caused an event, as the envelope's `actor` says it. The CLI is always the operator. */
interface EventActor {
  kind: "operator";
  /** `deployed_by_actor` style: the Cloudflare login's email, or `api-token:<account id>`. */
  id: string;
  email?: string;
}

/** The operator a Cloudflare login (or API token) stands for. */
export function operatorActor(deployer: Deployer): EventActor {
  return { kind: "operator", id: deployer.actor, ...(deployer.email ? { email: deployer.email } : {}) };
}

/** The catalogue's `app`: the manifest id, the registry row id, the display name. */
export interface EventApp {
  id: string;
  rowId: string;
  name: string;
}

// The outbox.

interface CliEventInput {
  organizationId: string;
  /** A catalogue type (`app.installed`); its version is the catalogue's. */
  type: string;
  actor: EventActor;
  /** The catalogue's `data` for the type: names and ids, never a secret or a value. */
  data: Record<string, unknown>;
  appRowId?: string | null;
  /** An event that must happen once: a second insert with the key is dropped, deliveries and all. */
  dedupeKey?: string;
  /**
   * An SQL condition, `?` placeholders and their values, the rows are
   * written under, checked when the batch runs: the write the event
   * reports took effect. Nothing is queued when it is false.
   */
  onlyIf?: { sql: string; params: D1Value[] };
  now?: number;
}

/**
 * The statements that queue an event from the CLI: the `events` row and a
 * pending delivery for each of the organization's enabled subscriptions
 * whose patterns match the type, due now, for the calling command to add to
 * its own batch after the write the event reports. Reads the
 * organization's subscriptions (a handful: patterns are matched here, as
 * the Gateway matches them).
 */
export async function queueEventFromCli(db: D1Database, input: CliEventInput): Promise<D1Statement[]> {
  const info = eventTypeInfo(input.type);
  if (!info) throw new Error(`${input.type} isn't in the event catalogue`);
  // The data builders are this package's own; a refusal here is a bug, not a person's mistake.
  const checked = checkEventData(input.data, EVENT_DATA_MAX_BYTES);
  if (!checked.ok) throw new Error(`${input.type}'s data: ${checked.message}`);
  const now = input.now ?? Date.now();
  const id = eventId(now);
  const [rows = []] = await db.run([
    {
      sql: "SELECT id, events, sink FROM event_subscriptions WHERE organization_id = ? AND enabled = 1",
      params: [input.organizationId],
    },
  ]);
  const matching = rows
    // An app's subscription takes only the families an app may read, as the Gateway's bus decides.
    .filter((row) => row["sink"] !== "app" || appSinkTypeAllowed(input.type))
    .filter((row) => eventSubscribed(patternsOf(row["events"]), input.type))
    .map((row) => String(row["id"]));
  const condition = input.onlyIf ? ` AND (${input.onlyIf.sql})` : "";
  return [
    {
      // A colliding dedupe key drops the row, and with it every delivery below.
      sql: `INSERT INTO events (id, organization_id, type, version, time, actor, actor_kind, actor_id, data, app_row_id, dedupe_key, created_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1${condition}
ON CONFLICT DO NOTHING`,
      params: [
        id,
        input.organizationId,
        input.type,
        info.version,
        now,
        JSON.stringify(input.actor),
        input.actor.kind,
        input.actor.id,
        JSON.stringify(input.data),
        input.appRowId ?? null,
        input.dedupeKey ?? null,
        now,
        ...(input.onlyIf?.params ?? []),
      ],
    },
    ...matching.map((subscription) => pendingDelivery(id, subscription, input.organizationId, now)),
  ];
}

/**
 * One pending delivery of event `id` to `subscription`, due now, written
 * only when the event row is there (its insert may have been dropped) and
 * the subscription is still the organization's and enabled.
 */
function pendingDelivery(id: string, subscription: string, organizationId: string, now: number): D1Statement {
  return {
    sql: `INSERT INTO event_deliveries (id, event_id, subscription_id, organization_id, status, attempts, next_attempt_at, created_at)
SELECT ?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5
WHERE EXISTS (SELECT 1 FROM events WHERE id = ?2)
  AND EXISTS (SELECT 1 FROM event_subscriptions WHERE id = ?3 AND organization_id = ?4 AND enabled = 1)`,
    params: [deliveryId(), id, subscription, organizationId, now],
  };
}

// The `app` sink: an app's own subscription, kept in step with its manifest.

/** What a manifest's `events` asks for, or null when it declares none. */
function declaredAppEvents(manifest: unknown): { subscribe: string[]; why: string } | null {
  if (!manifest || typeof manifest !== "object") return null;
  const events = (manifest as { events?: unknown }).events;
  if (!events || typeof events !== "object") return null;
  const { subscribe, why } = events as { subscribe?: unknown; why?: unknown };
  if (!Array.isArray(subscribe)) return null;
  return {
    subscribe: [...new Set(subscribe.map((pattern) => String(pattern).trim()).filter(Boolean))],
    why: typeof why === "string" ? why : "",
  };
}

/**
 * The statements that keep an app's `app` subscription in step with its
 * manifest's `events`, for the deploy's own batch (markDeployed): made
 * when the manifest first subscribes, its patterns and why replaced on each
 * deploy (paused stays paused), removed when the manifest no longer
 * subscribes. Always the app's own organization's. The patterns are
 * checked against the allowlist again, whatever validated the manifest.
 */
export function appSubscriptionStatements(
  app: { id: string; organizationId: string; name: string },
  manifest: unknown,
  input: { actor: string; now: number },
): D1Statement[] {
  const declared = declaredAppEvents(manifest);
  const scope = [app.id, app.organizationId];
  if (!declared) {
    return [
      {
        sql: "DELETE FROM event_subscriptions WHERE sink = 'app' AND app_row_id = ? AND organization_id = ?",
        params: scope,
      },
    ];
  }
  if (declared.subscribe.length === 0 || declared.subscribe.length > APP_SINK_PATTERNS_MAX) {
    throw new EveryAppError(
      "INVALID_MANIFEST",
      `events.subscribe lists 1 to ${APP_SINK_PATTERNS_MAX} event types or patterns`,
    );
  }
  for (const pattern of declared.subscribe) {
    const problem = appSinkPatternProblem(pattern);
    if (problem) throw new EveryAppError("INVALID_MANIFEST", `events.subscribe: ${problem}`);
  }
  const events = JSON.stringify(declared.subscribe);
  const name = app.name.slice(0, EVENT_SUBSCRIPTION_NAME_MAX);
  const description = declared.why.slice(0, 200) || null;
  return [
    {
      sql: `UPDATE event_subscriptions SET events = ?1, name = ?2, description = ?3, updated_at = ?4
WHERE sink = 'app' AND app_row_id = ?5 AND organization_id = ?6`,
      params: [events, name, description, input.now, ...scope],
    },
    {
      sql: `INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, recipients, events, enabled,
  builtin, description, created_at, updated_at, created_by, consecutive_failures, app_row_id)
SELECT ?1, ?2, ?3, 'app', NULL, NULL, NULL, ?4, 1, NULL, ?5, ?6, ?6, ?7, 0, ?8
WHERE NOT EXISTS (SELECT 1 FROM event_subscriptions WHERE sink = 'app' AND app_row_id = ?8 AND organization_id = ?2)`,
      params: [
        subscriptionId(),
        app.organizationId,
        name,
        events,
        description,
        input.now,
        `operator:${input.actor}`,
        app.id,
      ],
    },
  ];
}

/** The statement that drops a deleted app's `app` subscription. */
export function removeAppSubscription(app: { id: string; organizationId: string }): D1Statement[] {
  return [
    {
      sql: "DELETE FROM event_subscriptions WHERE sink = 'app' AND app_row_id = ? AND organization_id = ?",
      params: [app.id, app.organizationId],
    },
  ];
}

/** A subscription's `events` column: its JSON list, or everything when it doesn't read as one. */
function patternsOf(stored: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(stored));
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Unreadable: the Gateway would refuse to write one; read it as nothing.
  }
  return [];
}
