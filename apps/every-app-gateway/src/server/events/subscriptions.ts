/**
 * The subscriptions service (docs/design/2026-10-events-out.md, section
 * 5): what the server functions and the admin MCP tools
 * (server/toolbus/workspace-tools.ts) call for an owner's or admin's
 * subscriptions. Every read and write is scoped to the acting
 * organization. `add` validates the target URL against the
 * target rules and the patterns against the catalogue, generates a
 * signing secret when none was given and returns it once (no list ever
 * shows it again), and refuses the 26th subscription. `remove` disables a
 * built-in row instead of deleting it, so the gateway never recreates it
 * behind the person's back. `test` emits a ping to one subscription and
 * waits for the first attempt, so the caller can report the outcome.
 */
import { env } from "cloudflare:workers";
import {
  EVENT_EMAIL_RECIPIENTS,
  EVENT_SECRET_MAX_LENGTH,
  EVENT_SECRET_MIN_LENGTH,
  EVENT_SUBSCRIPTIONS_MAX,
  EVENT_SUBSCRIPTION_NAME_MAX,
  eventPatternProblem,
  type EventEmailRecipients,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import { PublicError } from "@/server/errors";
import { gatewayHosts } from "@/server/gateway-hosts";
import type { OrgContext } from "@/server/organization/orgContext";
import {
  EventDeliveryRepository,
  deliveryCursor,
  type DeliveryStatus,
  type ListedDelivery,
} from "@/server/repositories/EventDeliveryRepository";
import {
  EventSubscriptionRepository,
  type ListedSubscription,
} from "@/server/repositories/EventSubscriptionRepository";
import { emitAndWait, subscriptionPatterns } from "./bus";
import { catalogue, summarize } from "./catalogue";
import { attemptDeliveries } from "./deliver";
import { newSubscriptionId } from "./ids";
import { userActor } from "./subjects";
import { checkTarget, targetRulesFromEnv } from "./target";

/** The built-in email subscription the first cap creates (section 6). */
const CAP_ALERTS_BUILTIN = "cap_alerts";
const CAP_ALERTS_NAME = "Cap alerts";
const CAP_ALERTS_EVENTS = ["cap.warning", "cap.reached"];
const EMAIL_SUBSCRIPTION_NAME = "Email owners and admins";
const SECRET_PREFIX = "whsec_";
const DELIVERIES_PAGE_DEFAULT = 50;
/** The most deliveries one page holds: the UI's, the admin tool's (pinned by its test). */
export const DELIVERIES_PAGE_MAX = 100;

/** A subscription as the pages, the CLI and the tools see it. */
interface SubscriptionView {
  id: string;
  name: string;
  sink: "webhook" | "email";
  url: string | null;
  recipients: EventEmailRecipients | null;
  events: string[];
  enabled: boolean;
  builtin: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: "delivered" | "failed" | "dead" | null;
  consecutiveFailures: number;
}

/** Plain JSON, as the server functions may return it. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface DeliveryView {
  id: string;
  subscriptionId: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  redeliveredAt: string | null;
  createdAt: string;
  /** The event, as the envelope carries it (never anything secret, by construction). */
  event: {
    id: string;
    type: string;
    version: number;
    summary: string;
    time: string;
    actor: { [key: string]: JsonValue } | null;
    data: { [key: string]: JsonValue };
    appRowId: string | null;
  } | null;
}

interface AddSubscriptionInput {
  url?: string;
  email?: EventEmailRecipients;
  events?: string[];
  name?: string;
  secret?: string;
  description?: string;
}

interface UpdateSubscriptionInput {
  enabled?: boolean;
  events?: string[];
  name?: string;
  description?: string | null;
}

interface DeliveriesQuery {
  subscriptionId?: string;
  status?: DeliveryStatus;
  before?: string;
  limit?: number;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function view(row: ListedSubscription): SubscriptionView {
  return {
    id: row.id,
    name: row.name,
    sink: row.sink === "email" ? "email" : "webhook",
    url: row.url,
    recipients:
      row.recipients === "owners" || row.recipients === "admins"
        ? row.recipients
        : null,
    events: subscriptionPatterns(row),
    enabled: row.enabled,
    builtin: row.builtin,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastDeliveryAt: iso(row.lastDeliveryAt),
    lastDeliveryStatus:
      row.lastDeliveryStatus === "delivered" ||
      row.lastDeliveryStatus === "failed" ||
      row.lastDeliveryStatus === "dead"
        ? row.lastDeliveryStatus
        : null,
    consecutiveFailures: row.consecutiveFailures,
  };
}

function parseStored(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function deliveryView(row: ListedDelivery): DeliveryView {
  let event: DeliveryView["event"] = null;
  if (row.event) {
    const data = parseStored(row.event.data);
    const payload =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as { [key: string]: JsonValue })
        : {};
    const parsedActor = parseStored(row.event.actor);
    const actor =
      parsedActor && typeof parsedActor === "object"
        ? (parsedActor as { [key: string]: JsonValue })
        : null;
    event = {
      id: row.event.id,
      type: row.event.type,
      version: row.event.version,
      summary: summarize(row.event.type, payload, actor),
      time: row.event.time.toISOString(),
      actor,
      data: payload,
      appRowId: row.event.appRowId,
    };
  }
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    status:
      row.status === "delivered" || row.status === "dead"
        ? row.status
        : "pending",
    attempts: row.attempts,
    nextAttemptAt: iso(row.nextAttemptAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    deliveredAt: iso(row.deliveredAt),
    redeliveredAt: iso(row.redeliveredAt),
    createdAt: row.createdAt.toISOString(),
    event,
  };
}

/** 32 random bytes, base64url, prefixed: the one credential this service makes. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${SECRET_PREFIX}${base64}`;
}

/** The patterns, checked against the catalogue; none means everything. */
function checkPatterns(events: string[] | undefined): string[] {
  const patterns = [
    ...new Set((events ?? []).map((p) => p.trim()).filter(Boolean)),
  ];
  if (patterns.length === 0) return ["*"];
  for (const pattern of patterns) {
    const problem = eventPatternProblem(pattern);
    if (problem) throw new PublicError("EVENT_TYPE_UNKNOWN", problem);
  }
  return patterns;
}

function checkName(name: string | undefined, fallback: string): string {
  const trimmed = name?.replace(/\s+/g, " ").trim() ?? "";
  if (trimmed.length > EVENT_SUBSCRIPTION_NAME_MAX) {
    throw new PublicError(
      "INVALID_INPUT",
      `A subscription's name is at most ${EVENT_SUBSCRIPTION_NAME_MAX} characters.`,
    );
  }
  return trimmed || fallback;
}

function checkSecret(secret: string | undefined): string | null {
  if (secret === undefined || secret === "") return null;
  if (
    secret.length < EVENT_SECRET_MIN_LENGTH ||
    secret.length > EVENT_SECRET_MAX_LENGTH ||
    /\s/.test(secret)
  ) {
    throw new PublicError(
      "EVENT_SECRET_INVALID",
      `A signing secret is ${EVENT_SECRET_MIN_LENGTH} to ${EVENT_SECRET_MAX_LENGTH} characters with no spaces.`,
    );
  }
  return secret;
}

function checkUrl(url: string): string {
  const trimmed = url.trim();
  const settings = env as { EVENTS_ALLOW_PRIVATE_TARGETS?: string };
  const check = checkTarget(
    trimmed,
    targetRulesFromEnv(settings, gatewayHosts(env)),
  );
  if (!check.ok) throw new PublicError("EVENT_TARGET_REFUSED", check.message);
  return trimmed;
}

async function requireRoom(organizationId: string): Promise<void> {
  const count =
    await EventSubscriptionRepository.countByOrganization(organizationId);
  if (count >= EVENT_SUBSCRIPTIONS_MAX) {
    throw new PublicError(
      "EVENT_SUBSCRIPTIONS_LIMIT",
      `An organization has at most ${EVENT_SUBSCRIPTIONS_MAX} event subscriptions. Remove one first.`,
    );
  }
}

async function requireSubscription(
  ctx: OrgContext,
  id: string,
): Promise<ListedSubscription> {
  const row = await EventSubscriptionRepository.findById(id, ctx.orgId);
  if (!row) {
    throw new PublicError(
      "EVENT_SUBSCRIPTION_NOT_FOUND",
      "That subscription doesn't exist or was removed.",
    );
  }
  return row;
}

/** The organization's subscriptions, oldest first. */
async function list(
  ctx: OrgContext,
): Promise<{ subscriptions: SubscriptionView[] }> {
  const rows = await EventSubscriptionRepository.listByOrganization(ctx.orgId);
  return { subscriptions: rows.map(view) };
}

/**
 * Add a webhook (a URL, a secret given or generated) or an email
 * subscription (owners, or owners and admins). The generated secret is
 * returned here and nowhere else.
 */
async function add(
  ctx: OrgContext,
  input: AddSubscriptionInput,
  createdBy: string = ctx.userId,
): Promise<{ subscription: SubscriptionView; secret?: string }> {
  const url = input.url?.trim();
  if (url && input.email) {
    throw new PublicError(
      "EVENT_SINK_CONFLICT",
      "A subscription is a webhook URL or an email to owners and admins, not both.",
    );
  }
  if (!url && !input.email) {
    throw new PublicError(
      "INVALID_INPUT",
      "Give a webhook URL, or choose email to owners or admins.",
    );
  }
  if (input.email && !EVENT_EMAIL_RECIPIENTS.includes(input.email)) {
    throw new PublicError(
      "INVALID_INPUT",
      `Email recipients are ${EVENT_EMAIL_RECIPIENTS.join(" or ")}.`,
    );
  }
  const patterns = checkPatterns(input.events);
  await requireRoom(ctx.orgId);
  const now = new Date();
  const id = newSubscriptionId();
  const description = input.description?.trim() || null;
  if (url) {
    const target = checkUrl(url);
    const given = checkSecret(input.secret);
    const secret = given ?? generateSecret();
    await EventSubscriptionRepository.insert({
      id,
      organizationId: ctx.orgId,
      name: checkName(input.name, new URL(target).host),
      sink: "webhook",
      url: target,
      secret,
      recipients: null,
      events: JSON.stringify(patterns),
      enabled: true,
      builtin: null,
      description,
      createdAt: now,
      updatedAt: now,
      createdBy,
    });
    logEvent("events.subscription_added", {
      subscription: id,
      org: ctx.orgId,
      sink: "webhook",
      host: new URL(target).host,
    });
    const subscription = view(await requireSubscription(ctx, id));
    return given ? { subscription } : { subscription, secret };
  }
  await EventSubscriptionRepository.insert({
    id,
    organizationId: ctx.orgId,
    name: checkName(input.name, EMAIL_SUBSCRIPTION_NAME),
    sink: "email",
    url: null,
    secret: null,
    recipients: input.email!,
    events: JSON.stringify(patterns),
    enabled: true,
    builtin: null,
    description,
    createdAt: now,
    updatedAt: now,
    createdBy,
  });
  logEvent("events.subscription_added", {
    subscription: id,
    org: ctx.orgId,
    sink: "email",
    recipients: input.email,
  });
  return { subscription: view(await requireSubscription(ctx, id)) };
}

/** Change the switch, the patterns, the name or the description. */
async function update(
  ctx: OrgContext,
  id: string,
  input: UpdateSubscriptionInput,
): Promise<{ subscription: SubscriptionView }> {
  const existing = await requireSubscription(ctx, id);
  const patch: Parameters<typeof EventSubscriptionRepository.update>[2] = {};
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.events !== undefined) {
    patch.events = JSON.stringify(checkPatterns(input.events));
  }
  if (input.name !== undefined)
    patch.name = checkName(input.name, existing.name);
  if (input.description !== undefined) {
    patch.description = input.description?.trim() || null;
  }
  await EventSubscriptionRepository.update(id, ctx.orgId, patch);
  return { subscription: view(await requireSubscription(ctx, id)) };
}

/** Remove a subscription; a built-in one is disabled instead and says so. */
async function remove(
  ctx: OrgContext,
  id: string,
): Promise<{ removed: boolean; disabled: boolean }> {
  const existing = await requireSubscription(ctx, id);
  if (existing.builtin) {
    await EventSubscriptionRepository.update(id, ctx.orgId, { enabled: false });
    logEvent("events.subscription_disabled", {
      subscription: id,
      org: ctx.orgId,
      builtin: existing.builtin,
    });
    return { removed: false, disabled: true };
  }
  await EventSubscriptionRepository.deleteById(id, ctx.orgId);
  logEvent("events.subscription_removed", { subscription: id, org: ctx.orgId });
  return { removed: true, disabled: false };
}

/**
 * Send a ping to one subscription and report the first attempt: the
 * delivery as it stands after it (delivered, pending a retry, or dead).
 */
async function test(
  ctx: OrgContext,
  id: string,
): Promise<{ delivery: DeliveryView | null }> {
  const subscription = await requireSubscription(ctx, id);
  const queued = await emitAndWait({
    organizationId: ctx.orgId,
    actor: await userActor(ctx.userId),
    only: id,
    ...catalogue.ping({
      subscription: { id: subscription.id, name: subscription.name },
    }),
  });
  const deliveryId = queued?.deliveryIds[0];
  if (!deliveryId) return { delivery: null };
  const listed = await EventDeliveryRepository.findListedById(
    deliveryId,
    ctx.orgId,
  );
  return { delivery: listed ? deliveryView(listed) : null };
}

/** A page of the organization's deliveries, newest first. */
async function deliveries(
  ctx: OrgContext,
  query: DeliveriesQuery,
): Promise<{ deliveries: DeliveryView[]; nextCursor: string | null }> {
  const limit = Math.min(
    Math.max(1, query.limit ?? DELIVERIES_PAGE_DEFAULT),
    DELIVERIES_PAGE_MAX,
  );
  if (query.subscriptionId)
    await requireSubscription(ctx, query.subscriptionId);
  const rows = await EventDeliveryRepository.listForOrganization(ctx.orgId, {
    subscriptionId: query.subscriptionId,
    status: query.status,
    before: query.before,
    limit,
  });
  const last = rows[rows.length - 1];
  return {
    deliveries: rows.map(deliveryView),
    nextCursor: rows.length === limit && last ? deliveryCursor(last) : null,
  };
}

/** Queue a failed or dead delivery again, and attempt it now. */
async function redeliver(
  ctx: OrgContext,
  deliveryId: string,
): Promise<{ delivery: DeliveryView | null }> {
  const existing = await EventDeliveryRepository.findById(
    deliveryId,
    ctx.orgId,
  );
  if (!existing) {
    throw new PublicError(
      "EVENT_DELIVERY_NOT_FOUND",
      "That delivery doesn't exist any more.",
    );
  }
  const reset = await EventDeliveryRepository.resetForRedelivery(
    deliveryId,
    ctx.orgId,
    new Date(),
  );
  if (reset) {
    logEvent("events.redeliver", { delivery: deliveryId, org: ctx.orgId });
    await attemptDeliveries([deliveryId]);
  }
  const listed = await EventDeliveryRepository.findListedById(
    deliveryId,
    ctx.orgId,
  );
  return { delivery: listed ? deliveryView(listed) : null };
}

/**
 * The built-in "Cap alerts" email subscription (section 6), made once per
 * organization with its first cap; a disabled one is left alone.
 */
async function ensureCapAlerts(organizationId: string): Promise<void> {
  const existing = await EventSubscriptionRepository.findBuiltin(
    organizationId,
    CAP_ALERTS_BUILTIN,
  );
  if (existing) return;
  const now = new Date();
  await EventSubscriptionRepository.insert({
    id: newSubscriptionId(),
    organizationId,
    name: CAP_ALERTS_NAME,
    sink: "email",
    url: null,
    secret: null,
    recipients: "admins",
    events: JSON.stringify(CAP_ALERTS_EVENTS),
    enabled: true,
    builtin: CAP_ALERTS_BUILTIN,
    description: "Owners and admins get an email at 80% and at the cap.",
    createdAt: now,
    updatedAt: now,
    createdBy: null,
  });
}

export const EventSubscriptionService = {
  list,
  add,
  update,
  remove,
  test,
  deliveries,
  redeliver,
  ensureCapAlerts,
} as const;
