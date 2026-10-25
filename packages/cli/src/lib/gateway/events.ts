/**
 * The event bus's rows in the Gateway's D1, written by the CLI itself
 * (docs/design/2026-10-events-out.md, sections 3, 4 and 8; ADR-0003: D1
 * write access to the Gateway's account is operator authority), the way
 * `provider on` and `email set` write the registry. Two jobs:
 *
 *  - `everyapp events …`: an organization's subscriptions (list, add,
 *    remove, enable, disable), a test ping to one of them, the delivery
 *    log and a redeliver. Each mirrors a check of the Gateway's service
 *    (server/events/subscriptions.ts), with the guards on the write itself
 *    where a row may change between the read and the write: the 25
 *    subscriptions an organization may have are counted by the insert, and
 *    every statement carries the organization's id.
 *  - The outbox (`queueEventFromCli`): the `events` row and one pending
 *    `event_deliveries` row per matching subscription, as statements the
 *    calling command adds to its own D1 batch, so an `app.installed` is
 *    queued atomically with the registration it reports. The Gateway's
 *    per-minute sweep delivers them; the CLI never calls a receiver.
 *
 * The rows hold what the Gateway's bus writes and nothing more: the
 * Gateway builds the envelope (organization, gateway URL, the catalogue's
 * summary) from them at delivery time. A Gateway whose D1 predates
 * migration 0012 has no event tables: the outbox writes nothing there
 * (`hasEventsTables`), and the `events` commands refuse with
 * GATEWAY_OUTDATED. Nothing here returns a subscription's secret except
 * `addSubscription`, which returns the one it was given or made.
 */
import { randomBytes } from "node:crypto";
import {
  checkEventData,
  EVENT_DATA_MAX_BYTES,
  EVENT_RETENTION_DAYS,
  EVENT_SECRET_MAX_LENGTH,
  EVENT_SECRET_MIN_LENGTH,
  EVENT_SUBSCRIPTION_NAME_MAX,
  EVENT_SUBSCRIPTIONS_MAX,
  eventPatternProblem,
  eventSubscribed,
  eventTypeInfo,
  type EventEmailRecipients,
} from "@every-app/sdk/internal";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { deliveryId, eventId, subscriptionId } from "./eventIds";
import { checkEventTarget, type EventTargetRules } from "./eventTarget";
import type { Deployer } from "./registry";

type D1Row = Record<string, unknown>;
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

const eventsTables = new WeakMap<D1Database, Promise<boolean>>();

/**
 * Whether the Gateway's D1 has the event bus's tables (migration 0012,
 * 2026-10-25, which also added `apps.setup_state`). Asked of each
 * database once, like `hasSecretNamesColumn`.
 */
export function hasEventsTables(db: D1Database): Promise<boolean> {
  let known = eventsTables.get(db);
  if (!known) {
    known = db.run([{ sql: "PRAGMA table_info(events)" }]).then(([rows = []]) => rows.length > 0);
    eventsTables.set(db, known);
  }
  return known;
}

/** Refuse a command that needs the event tables on a Gateway from before them. */
export async function requireEventsTables(db: D1Database): Promise<void> {
  if (await hasEventsTables(db)) return;
  throw new EveryAppError(
    "GATEWAY_OUTDATED",
    "The Gateway predates events\nIts database has no event tables until the Gateway is updated to a release that has them.",
    { rerun: `${CLI} update`, rerunNote: "then run this again" },
  );
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
 * the Gateway matches them). Empty on a Gateway without the event tables,
 * so the command goes on as before.
 */
export async function queueEventFromCli(db: D1Database, input: CliEventInput): Promise<D1Statement[]> {
  if (!(await hasEventsTables(db))) return [];
  const info = eventTypeInfo(input.type);
  if (!info) throw new Error(`${input.type} isn't in the event catalogue`);
  // The data builders are this package's own; a refusal here is a bug, not a person's mistake.
  const checked = checkEventData(input.data, EVENT_DATA_MAX_BYTES);
  if (!checked.ok) throw new Error(`${input.type}'s data: ${checked.message}`);
  const now = input.now ?? Date.now();
  const id = eventId(now);
  const [rows = []] = await db.run([
    {
      sql: "SELECT id, events FROM event_subscriptions WHERE organization_id = ? AND enabled = 1",
      params: [input.organizationId],
    },
  ]);
  const matching = rows
    .filter((row) => eventSubscribed(patternsOf(row["events"]), input.type))
    .map((row) => String(row["id"]));
  const condition = input.onlyIf ? ` AND (${input.onlyIf.sql})` : "";
  return [
    {
      // A colliding dedupe key drops the row, and with it every delivery below.
      sql: `INSERT INTO events (id, organization_id, type, version, time, actor, data, app_row_id, dedupe_key, created_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1${condition}
ON CONFLICT DO NOTHING`,
      params: [
        id,
        input.organizationId,
        input.type,
        info.version,
        now,
        JSON.stringify(input.actor),
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

/**
 * The organization's built-in "Cap alerts" subscription, as the Gateway's
 * EventSubscriptionService.ensureCapAlerts makes it on the organization's
 * first cap (docs/design/2026-10-events-out.md, section 6): owners and
 * admins emailed on `cap.warning` and `cap.reached`.
 */
const CAP_ALERTS_BUILTIN = "cap_alerts";
const CAP_ALERTS_NAME = "Cap alerts";
const CAP_ALERTS_EVENTS = ["cap.warning", "cap.reached"];

/**
 * The statement that makes the organization's Cap alerts subscription when
 * it has none, for a cap write's own batch; it returns the new row's id,
 * and nothing when a row with the builtin is already there, even a
 * disabled one: the Gateway never makes it again once a person turned it
 * off. Null on a Gateway without the event tables.
 */
export async function capAlertsStatement(
  db: D1Database,
  input: { organizationId: string; deployer: Deployer; now: number },
): Promise<D1Statement | null> {
  if (!(await hasEventsTables(db))) return null;
  return {
    sql: `INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, recipients, events, enabled,
  builtin, description, created_at, updated_at, created_by, consecutive_failures)
SELECT ?1, ?2, ?3, 'email', NULL, NULL, 'admins', ?4, 1, ?5, ?6, ?7, ?7, ?8, 0
WHERE NOT EXISTS (SELECT 1 FROM event_subscriptions WHERE organization_id = ?2 AND builtin = ?5)
RETURNING id`,
    params: [
      subscriptionId(),
      input.organizationId,
      CAP_ALERTS_NAME,
      JSON.stringify(CAP_ALERTS_EVENTS),
      CAP_ALERTS_BUILTIN,
      "Owners and admins get an email at 80% and at the cap.",
      input.now,
      `operator:${input.deployer.actor}`,
    ],
  };
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

// Subscriptions.

export interface Subscription {
  id: string;
  name: string;
  sink: "webhook" | "email";
  /** The webhook's URL as stored; null for the email sink. */
  url: string | null;
  recipients: EventEmailRecipients | null;
  events: string[];
  enabled: boolean;
  /** `cap_alerts` for the one the Gateway makes with the first cap; null for a person's. */
  builtin: string | null;
  description: string | null;
  createdAt: number;
  createdBy: string | null;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: string | null;
  consecutiveFailures: number;
}

// Never `secret`: no surface lists it again once it was shown.
const SUBSCRIPTION_COLUMNS =
  "id, name, sink, url, recipients, events, enabled, builtin, description, created_at, created_by, last_delivery_at, last_delivery_status, consecutive_failures";

const numberOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
const textOrNull = (value: unknown): string | null => (value == null ? null : String(value));

function toSubscription(row: D1Row): Subscription {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    sink: row["sink"] === "email" ? "email" : "webhook",
    url: textOrNull(row["url"]),
    recipients: row["recipients"] === "owners" || row["recipients"] === "admins" ? row["recipients"] : null,
    events: patternsOf(row["events"]),
    enabled: Number(row["enabled"]) === 1,
    builtin: textOrNull(row["builtin"]),
    description: textOrNull(row["description"]),
    createdAt: Number(row["created_at"]),
    createdBy: textOrNull(row["created_by"]),
    lastDeliveryAt: numberOrNull(row["last_delivery_at"]),
    lastDeliveryStatus: textOrNull(row["last_delivery_status"]),
    consecutiveFailures: Number(row["consecutive_failures"] ?? 0),
  };
}

/** The organization's subscriptions, oldest first. */
export async function listSubscriptions(db: D1Database, organizationId: string): Promise<Subscription[]> {
  await requireEventsTables(db);
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${SUBSCRIPTION_COLUMNS} FROM event_subscriptions WHERE organization_id = ? ORDER BY created_at, id`,
      params: [organizationId],
    },
  ]);
  return rows.map(toSubscription);
}

function subscriptionNotFound(id: string, organizationName: string): EveryAppError {
  return new EveryAppError(
    "EVENT_SUBSCRIPTION_NOT_FOUND",
    `No subscription ${id} in ${organizationName}\nSubscriptions belong to one organization; --org names another.`,
    { rerun: `${CLI} events list`, rerunNote: "lists them" },
  );
}

/** One of the organization's subscriptions, or EVENT_SUBSCRIPTION_NOT_FOUND. */
export async function findSubscription(
  db: D1Database,
  organization: { id: string; name: string },
  id: string,
): Promise<Subscription> {
  await requireEventsTables(db);
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${SUBSCRIPTION_COLUMNS} FROM event_subscriptions WHERE id = ? AND organization_id = ?`,
      params: [id.trim(), organization.id],
    },
  ]);
  if (!rows[0]) throw subscriptionNotFound(id.trim(), organization.name);
  return toSubscription(rows[0]);
}

/**
 * The patterns `--events` names (each a comma list; repeated flags add
 * up), trimmed and each once, in order; everything (`*`) when none. A
 * name that is no type, prefix or app pattern is refused with
 * EVENT_TYPE_UNKNOWN, all of them at once.
 */
export function eventPatterns(values: readonly string[] | undefined): string[] {
  const patterns = [
    ...new Set((values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean)),
  ];
  if (patterns.length === 0) return ["*"];
  const problems = patterns.flatMap((pattern) => {
    const problem = eventPatternProblem(pattern);
    return problem ? [{ pattern, problem }] : [];
  });
  if (problems.length > 0) {
    throw new EveryAppError(
      "EVENT_TYPE_UNKNOWN",
      [
        problems.length === 1 ? `${problems[0]!.pattern} isn't an event type` : `${problems.length} of --events aren't event types`,
        ...problems.map((entry) => entry.problem),
      ].join("\n"),
      {
        fix: "name types (member.joined), prefixes (member.*), an app's own events (app.crm.*) or * for everything",
        rerun: `${CLI} events types`,
        rerunNote: "lists the types",
        data: { patterns: problems.map((entry) => entry.pattern) },
      },
    );
  }
  // `*` already says everything; a list with it means just that.
  return patterns.includes("*") ? ["*"] : patterns;
}

/** A webhook URL the target rules let through, as stored; EVENT_TARGET_REFUSED otherwise. */
export function webhookUrl(raw: string, rules: EventTargetRules): string {
  const checked = checkEventTarget(raw, rules);
  if (checked.ok) return checked.url;
  throw new EveryAppError("EVENT_TARGET_REFUSED", `The Gateway won't deliver to that URL\n${checked.reason}`, {
    ...(checked.private
      ? {
          fix: `use a public https:// receiver; for one on a private network, set EVENTS_ALLOW_PRIVATE_TARGETS on the Gateway (${CLI} secret set EVENTS_ALLOW_PRIVATE_TARGETS, value true; self-host only)`,
        }
      : { fix: "give the receiver's full https:// URL (Slack's, Zapier's, n8n's, your own)" }),
  });
}

const SECRET_CHARACTERS = /^[\x21-\x7e]+$/;

/** A signing secret someone gave, as stored; EVENT_SECRET_INVALID when it won't do. */
export function checkedSecret(secret: string): string {
  const problem =
    secret.length < EVENT_SECRET_MIN_LENGTH || secret.length > EVENT_SECRET_MAX_LENGTH
      ? `A signing secret is ${EVENT_SECRET_MIN_LENGTH} to ${EVENT_SECRET_MAX_LENGTH} characters (this one is ${secret.length}).`
      : !SECRET_CHARACTERS.test(secret)
        ? "A signing secret is printable ASCII with no spaces, so every receiver's HMAC reads the same bytes."
        : null;
  if (!problem) return secret;
  throw new EveryAppError("EVENT_SECRET_INVALID", `That signing secret won't do\n${problem}`, {
    fix: "leave --secret out and the CLI makes one, or give one of 16 to 128 printable characters",
  });
}

/** A new signing secret: `whsec_` and 32 random bytes, base64url. */
export const generatedSecret = (): string => `whsec_${randomBytes(32).toString("base64url")}`;

/** A subscription's name as given, trimmed, one line, at most 100 characters; null to take the default. */
export function subscriptionName(name: string | undefined): string | null {
  const trimmed = name?.replace(/\s+/g, " ").trim() ?? "";
  if (trimmed === "") return null;
  return trimmed.length > EVENT_SUBSCRIPTION_NAME_MAX ? trimmed.slice(0, EVENT_SUBSCRIPTION_NAME_MAX) : trimmed;
}

export type SubscriptionTarget =
  | { sink: "webhook"; url: string; secret: string }
  | { sink: "email"; recipients: EventEmailRecipients };

interface AddSubscriptionInput {
  organization: { id: string; name: string };
  name: string;
  events: string[];
  target: SubscriptionTarget;
  deployer: Deployer;
  now?: number;
}

/**
 * Add a subscription. The insert counts the organization's subscriptions
 * itself, so two adds at once can't make a 26th: EVENT_SUBSCRIPTIONS_LIMIT.
 */
export async function addSubscription(db: D1Database, input: AddSubscriptionInput): Promise<Subscription> {
  await requireEventsTables(db);
  const now = input.now ?? Date.now();
  const id = subscriptionId();
  const { target } = input;
  const [inserted = []] = await db.run([
    {
      sql: `INSERT INTO event_subscriptions (id, organization_id, name, sink, url, secret, recipients, events, enabled,
  builtin, description, created_at, updated_at, created_by, consecutive_failures)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, NULL, NULL, ?9, ?9, ?10, 0
WHERE (SELECT COUNT(*) FROM event_subscriptions WHERE organization_id = ?2) < ?11
RETURNING ${SUBSCRIPTION_COLUMNS}`,
      params: [
        id,
        input.organization.id,
        input.name,
        target.sink,
        target.sink === "webhook" ? target.url : null,
        target.sink === "webhook" ? target.secret : null,
        target.sink === "email" ? target.recipients : null,
        JSON.stringify(input.events),
        now,
        `operator:${input.deployer.actor}`,
        EVENT_SUBSCRIPTIONS_MAX,
      ],
    },
  ]);
  if (!inserted[0]) {
    throw new EveryAppError(
      "EVENT_SUBSCRIPTIONS_LIMIT",
      `${input.organization.name} has ${EVENT_SUBSCRIPTIONS_MAX} subscriptions, the most an organization may have\nNothing was added.`,
      {
        fix: `remove one you no longer need (${CLI} events remove <id>), or widen one's --events instead of adding another`,
        rerun: `${CLI} events list`,
        rerunNote: "lists them",
      },
    );
  }
  return toSubscription(inserted[0]);
}

/**
 * Remove a subscription; a built-in one (the Gateway's cap alerts) is
 * disabled instead, so the Gateway never makes it again behind the
 * person's back. Its deliveries stay in the log; the Gateway's sweep drops
 * any still pending.
 */
export async function removeSubscription(
  db: D1Database,
  organization: { id: string; name: string },
  id: string,
  now = Date.now(),
): Promise<{ subscription: Subscription; outcome: "removed" | "disabled" }> {
  const subscription = await findSubscription(db, organization, id);
  if (subscription.builtin) {
    await db.run([
      {
        sql: "UPDATE event_subscriptions SET enabled = 0, updated_at = ? WHERE id = ? AND organization_id = ?",
        params: [now, subscription.id, organization.id],
      },
    ]);
    return { subscription: { ...subscription, enabled: false }, outcome: "disabled" };
  }
  await db.run([
    {
      sql: "DELETE FROM event_subscriptions WHERE id = ? AND organization_id = ?",
      params: [subscription.id, organization.id],
    },
  ]);
  return { subscription, outcome: "removed" };
}

/** Pause or resume a subscription: a paused one gets no new deliveries. Whether it changed. */
export async function setSubscriptionEnabled(
  db: D1Database,
  organization: { id: string; name: string },
  id: string,
  enabled: boolean,
  now = Date.now(),
): Promise<{ subscription: Subscription; changed: boolean }> {
  const subscription = await findSubscription(db, organization, id);
  if (subscription.enabled === enabled) return { subscription, changed: false };
  await db.run([
    {
      sql: "UPDATE event_subscriptions SET enabled = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
      params: [enabled ? 1 : 0, now, subscription.id, organization.id],
    },
  ]);
  return { subscription: { ...subscription, enabled }, changed: true };
}

/** A subscription that is paused: the Gateway drops what is queued for it. */
export function subscriptionDisabled(subscription: Subscription, doing: string): EveryAppError {
  return new EveryAppError(
    "EVENT_SUBSCRIPTION_DISABLED",
    `${subscription.name} (${subscription.id}) is disabled\nThe Gateway drops what is queued for a disabled subscription, so ${doing} would go nowhere.`,
    { rerun: `${CLI} events enable ${subscription.id}`, rerunNote: "then run this again" },
  );
}

// Deliveries.

export interface Delivery {
  id: string;
  eventId: string;
  /** The event's type; null when the event row is gone (past retention). */
  type: string | null;
  subscriptionId: string;
  /** The subscription's name; null when it was removed since. */
  subscriptionName: string | null;
  /** The subscription's sink; null when it was removed since. */
  sink: "webhook" | "email" | null;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  nextAttemptAt: number | null;
  claimedUntil: number | null;
  lastAttemptAt: number | null;
  /** The HTTP status; for the email sink, the number of recipients mailed. */
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: number | null;
  redeliveredAt: number | null;
  createdAt: number;
}

const DELIVERY_COLUMNS = `d.id, d.event_id, e.type, d.subscription_id, s.name AS subscription_name, s.sink, d.status, d.attempts,
  d.next_attempt_at, d.claimed_until, d.last_attempt_at, d.last_status_code, d.last_error, d.delivered_at,
  d.redelivered_at, d.created_at`;
const DELIVERY_FROM = `FROM event_deliveries d
LEFT JOIN events e ON e.id = d.event_id
LEFT JOIN event_subscriptions s ON s.id = d.subscription_id AND s.organization_id = d.organization_id`;

function toDelivery(row: D1Row): Delivery {
  const status = String(row["status"]);
  return {
    id: String(row["id"]),
    eventId: String(row["event_id"]),
    type: textOrNull(row["type"]),
    subscriptionId: String(row["subscription_id"]),
    subscriptionName: textOrNull(row["subscription_name"]),
    sink: row["sink"] === "email" ? "email" : row["sink"] === "webhook" ? "webhook" : null,
    status: status === "delivered" || status === "dead" ? status : "pending",
    attempts: Number(row["attempts"] ?? 0),
    nextAttemptAt: numberOrNull(row["next_attempt_at"]),
    claimedUntil: numberOrNull(row["claimed_until"]),
    lastAttemptAt: numberOrNull(row["last_attempt_at"]),
    lastStatusCode: numberOrNull(row["last_status_code"]),
    lastError: textOrNull(row["last_error"]),
    deliveredAt: numberOrNull(row["delivered_at"]),
    redeliveredAt: numberOrNull(row["redelivered_at"]),
    createdAt: Number(row["created_at"]),
  };
}

/**
 * Where a delivery stands: delivered; dead (out of attempts, or dropped);
 * failed (its last attempt failed, and the Gateway retries it); or pending
 * (not attempted yet, or an attempt is running).
 */
export function deliveryState(delivery: Delivery, now = Date.now()): "delivered" | "dead" | "failed" | "pending" {
  if (delivery.status !== "pending") return delivery.status;
  const attempting = delivery.claimedUntil !== null && delivery.claimedUntil > now;
  return delivery.attempts > 0 && delivery.lastError !== null && !attempting ? "failed" : "pending";
}

export const DELIVERIES_LIMIT_MAX = 200;

/** The organization's last deliveries (newest first, within retention), of one subscription or all, dead ones only with `dead`. */
export async function listDeliveries(
  db: D1Database,
  input: { organizationId: string; subscriptionId?: string; dead?: boolean; limit: number; now?: number },
): Promise<Delivery[]> {
  await requireEventsTables(db);
  const since = (input.now ?? Date.now()) - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const where = [
    "d.organization_id = ?",
    "d.created_at >= ?",
    ...(input.subscriptionId ? ["d.subscription_id = ?"] : []),
    ...(input.dead ? ["d.status = 'dead'"] : []),
  ];
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${DELIVERY_COLUMNS} ${DELIVERY_FROM} WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
      params: [
        input.organizationId,
        since,
        ...(input.subscriptionId ? [input.subscriptionId] : []),
        Math.min(Math.max(1, Math.floor(input.limit)), DELIVERIES_LIMIT_MAX),
      ],
    },
  ]);
  return rows.map(toDelivery);
}

/** One of the organization's deliveries, or null. */
async function readDelivery(db: D1Database, organizationId: string, id: string): Promise<Delivery | null> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${DELIVERY_COLUMNS} ${DELIVERY_FROM} WHERE d.id = ? AND d.organization_id = ?`,
      params: [id, organizationId],
    },
  ]);
  return rows[0] ? toDelivery(rows[0]) : null;
}

/**
 * Send a delivery again, as the Gateway's redeliver does
 * (EventDeliveryRepository.resetForRedelivery): a pending or dead one goes
 * back to pending, due now, `redelivered_at` stamped, its attempts back to
 * 0 so it gets the full retry schedule. A delivered one is left alone
 * (`delivered`), and so is one an attempt holds right now (`attempting`).
 * EVENT_DELIVERY_NOT_FOUND
 * for another organization's or one past retention; a delivery whose
 * subscription is gone or paused is refused, since the Gateway would drop it.
 */
export async function redeliver(
  db: D1Database,
  organization: { id: string; name: string },
  id: string,
  now = Date.now(),
): Promise<{ delivery: Delivery; previous: Delivery; outcome: "queued" | "attempting" | "delivered" }> {
  await requireEventsTables(db);
  const previous = await readDelivery(db, organization.id, id.trim());
  if (!previous) {
    throw new EveryAppError(
      "EVENT_DELIVERY_NOT_FOUND",
      `No delivery ${id.trim()} in ${organization.name}\nDeliveries are kept ${EVENT_RETENTION_DAYS} days, under the organization of their subscription.`,
      { rerun: `${CLI} events deliveries`, rerunNote: "lists the last ones" },
    );
  }
  const subscription = await findSubscription(db, organization, previous.subscriptionId).catch((error: unknown) => {
    if (error instanceof EveryAppError && error.code === "EVENT_SUBSCRIPTION_NOT_FOUND") {
      throw new EveryAppError(
        "EVENT_SUBSCRIPTION_NOT_FOUND",
        `${previous.id} was for ${previous.subscriptionId}, which is removed\nThere is nowhere to send it again.`,
        { rerun: `${CLI} events list`, rerunNote: "lists the subscriptions there are" },
      );
    }
    throw error;
  });
  if (!subscription.enabled) throw subscriptionDisabled(subscription, "sending it again");
  const [changed = []] = await db.run([
    {
      sql: `UPDATE event_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?1, redelivered_at = ?1, claimed_until = NULL
WHERE id = ?2 AND organization_id = ?3 AND status IN ('pending', 'dead') AND (claimed_until IS NULL OR claimed_until <= ?1)
RETURNING id`,
      params: [now, previous.id, organization.id],
    },
  ]);
  const delivery = (await readDelivery(db, organization.id, previous.id)) ?? previous;
  const outcome = changed.length > 0 ? "queued" : delivery.status === "delivered" ? "delivered" : "attempting";
  return { delivery, previous, outcome };
}

/**
 * Queue a `ping` for one subscription (the Gateway's `subscriptions.test`
 * rows): the event, scoped to that subscription by its one delivery, due
 * now. The Gateway's per-minute sweep sends it.
 */
export async function queuePing(
  db: D1Database,
  input: { organizationId: string; subscription: Subscription; actor: EventActor; now?: number },
): Promise<{ eventId: string; deliveryId: string }> {
  await requireEventsTables(db);
  const now = input.now ?? Date.now();
  const event = eventId(now);
  const delivery = deliveryId();
  const data = {
    subscription: { id: input.subscription.id, name: input.subscription.name },
    message: "A test event from everyapp events test. A signed delivery like this one means the subscription works.",
  };
  await db.run([
    {
      sql: `INSERT INTO events (id, organization_id, type, version, time, actor, data, app_row_id, dedupe_key, created_at)
VALUES (?1, ?2, 'ping', ?3, ?4, ?5, ?6, NULL, NULL, ?4)`,
      params: [event, input.organizationId, eventTypeInfo("ping")!.version, now, JSON.stringify(input.actor), JSON.stringify(data)],
    },
    {
      sql: `INSERT INTO event_deliveries (id, event_id, subscription_id, organization_id, status, attempts, next_attempt_at, created_at)
VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5)`,
      params: [delivery, event, input.subscription.id, input.organizationId, now],
    },
  ]);
  return { eventId: event, deliveryId: delivery };
}

/** How `waitForDelivery` waits; tests shorten it. */
export interface DeliveryWait {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Give up after this long (default 90 seconds: the sweep runs every minute). */
  timeoutMs?: number;
  /** Look again this often (default 3 seconds). */
  intervalMs?: number;
}

export const TEST_WAIT_MS = 90_000;

/**
 * Wait for a delivery to settle: delivered, failed (its first attempt
 * failed) or dead. Null when it is still waiting for its attempt after
 * `timeoutMs`.
 */
export async function waitForDelivery(
  db: D1Database,
  organizationId: string,
  id: string,
  wait: DeliveryWait = {},
): Promise<Delivery | null> {
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = wait.now ?? Date.now;
  const deadline = now() + (wait.timeoutMs ?? TEST_WAIT_MS);
  for (;;) {
    const delivery = await readDelivery(db, organizationId, id);
    if (delivery && deliveryState(delivery, now()) !== "pending") return delivery;
    if (now() >= deadline) return null;
    await sleep(Math.min(wait.intervalMs ?? 3_000, Math.max(0, deadline - now())));
  }
}
