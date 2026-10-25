/**
 * The event bus against a migrated SQLite database: what emit writes,
 * what a subscription gets, the delivery loop's outcomes and retries, the
 * signed webhook, the email sink, the sweep's claim, redelivery, the
 * target rules, retention, and each emit point in the gateway firing
 * once. The names are what docs/threat-model-invariants.md cites for
 * docs/design/2026-10-events-out.md section 12.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const background = vi.hoisted(() => [] as Promise<unknown>[]);
const workerEnv = vi.hoisted(
  () =>
    ({
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      GATEWAY_URL: "https://gateway.example.com",
      APP_BASE_DOMAIN: "gateway.example.com",
      BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
      EVERYAPP_RELEASE: { version: "1.2.3", sha256: "x" },
      DB: {},
    }) as Record<string, unknown>,
);

vi.mock("cloudflare:workers", () => ({
  env: workerEnv,
  waitUntil: (task: Promise<unknown>) => background.push(task),
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(testDb), schema };
});
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => testDb.current }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));
vi.mock("@/server/mcp-auth/config", () => ({ getMcpAuth: () => null }));

import { eq, like } from "drizzle-orm";
import {
  APP_EVENT_RATE_PER_HOUR,
  AUDIT_RETENTION_DAYS,
  PROVIDER_APP_TIER,
  EVENT_DELIVERY_MAX_ATTEMPTS,
  EVENT_HEADERS,
  EVENT_RETENTION_DAYS,
  EVENT_RETRY_DELAYS_MS,
  EVENT_TYPES,
  CREDENTIAL_KEY_PATTERN,
  checkEventData,
  EVENT_DATA_MAX_BYTES,
} from "@every-app/sdk/internal";
import { validateManifest } from "@every-app/perimeter/manifest";
import { ensureAccessMembership } from "@/auth/cloudflare-access/membership";
import { eventDeliveries, events, eventSubscriptions } from "@/db/schema";
import {
  refuseUnreadyApp,
  resetNeedsSetupLogForTests,
} from "@/server/app-needs-setup";
import { loadAppEmitDeps } from "@/server/events/app-emit";
import { emit, emitAndWait, queueEvent } from "@/server/events/bus";
import {
  catalogue,
  eventEmailFields,
  summarize,
  type EventActor,
} from "@/server/events/catalogue";
import {
  attemptDeliveries,
  deliverOnce,
  setDeliveryDepsForTests,
  sweep,
  type DeliveryDeps,
} from "@/server/events/deliver";
import type { EventMailer } from "@/server/events/email-sink";
import { verifyEventSignature } from "@/server/events/signing";
import {
  EventSubscriptionService,
  generateSecret,
} from "@/server/events/subscriptions";
import * as subjects from "@/server/events/subjects";
import { clearEventSubjectCachesForTests } from "@/server/events/subjects";
import { checkTarget } from "@/server/events/target";
import {
  clearCapEventMemoryForTests,
  noteCapCheck,
} from "@/server/events/cap-events";
import { clearSetupStateMemoryForTests } from "@/server/events/setup-state";
import {
  announceToolCall,
  announceToolsChanged,
} from "@/server/events/tool-events";
import { runMcpMaintenance } from "@/server/mcp-auth/maintenance";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { EventDeliveryRepository } from "@/server/repositories/EventDeliveryRepository";
import { EventRepository } from "@/server/repositories/EventRepository";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";
import { AdminService } from "@/server/services/AdminService";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppCapService } from "@/server/services/AppCapService";
import { AppService } from "@/server/services/AppService";
import { GroupService } from "@/server/services/GroupService";
import { OrganizationService } from "@/server/services/OrganizationService";
import { runWorkspaceTool } from "@/server/toolbus/workspace-tools";
import { InvitationService } from "@/server/services/InvitationService";
import { listedAppSetup } from "@/server/services/listedAppSetup";
import { McpConnectionService } from "@/server/services/McpConnectionService";
import { MembershipService } from "@/server/services/MembershipService";
import { SetupService } from "@/server/services/SetupService";
import { UserPatService } from "@/server/services/UserPatService";
import { clearAppCapCache, type MonthlyCapCheck } from "@/server/app-cap";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import { createAuth } from "@/auth";
import {
  apps,
  invitations,
  members,
  ownerSetupTokens,
  rateLimitCounters,
  users,
} from "@/db/schema";
import { registerApp } from "@/test/registry";
import { createHash } from "node:crypto";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

type Role = "owner" | "admin" | "member";

/** Every background task the code queued, drained. */
async function settleBackground(): Promise<void> {
  while (background.length > 0) {
    const tasks = background.splice(0);
    await Promise.allSettled(tasks);
  }
}

describe("the event bus (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let globex: string;
  let owner: string;
  let admin: string;
  let member: string;
  let clock: Date;
  const fetchMock = vi.fn<typeof fetch>();
  const sendMock = vi.fn<EventMailer["send"]>();
  let emailConfigured = true;
  const mailer: EventMailer = {
    isConfigured: () => emailConfigured,
    send: (options) => sendMock(options),
    recipientHash: async (address) => `h(${address.length})`,
  };
  const deps: DeliveryDeps = {
    fetch: (input, init) => fetchMock(input, init),
    mailer: async () => mailer,
    now: () => clock,
    gatewayUrl: () => "https://gateway.example.com",
    userAgent: () => "every-app-gateway/1.2.3",
    targetRules: () => ({
      allowPrivate: false,
      gatewayHosts: ["gateway.example.com"],
    }),
  };
  const ctx = (userId: string, role: Role = "owner") => ({
    orgId: acme,
    userId,
    role,
  });
  const asOwner = () => ctx(owner, "owner");

  /** The clock every path reads: the injected one and `new Date()` alike. */
  function setClock(date: Date): void {
    clock = date;
    vi.setSystemTime(date);
  }

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(new Date("2026-10-25T10:00:00.000Z"));
    emailConfigured = true;
    fetchMock
      .mockReset()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    sendMock.mockReset().mockResolvedValue({ status: "delivered" });
    setDeliveryDepsForTests(deps);
    clearEventSubjectCachesForTests();
    clearCapEventMemoryForTests();
    background.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    acme = await seedOrganization(db, "acme");
    globex = await seedOrganization(db, "globex");
    owner = await seedMember(db, {
      organizationId: acme,
      role: "owner",
      email: "ada@acme.example",
    });
    admin = await seedMember(db, {
      organizationId: acme,
      role: "admin",
      email: "bo@acme.example",
    });
    member = await seedMember(db, {
      organizationId: acme,
      role: "member",
      email: "cy@acme.example",
    });
    await seedMember(db, { organizationId: globex, role: "owner" });
  });

  afterEach(() => {
    setDeliveryDepsForTests(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Forget the bus's own housekeeping (`subscription.*`, which adding or
   * changing a subscription emits) so a test counts only the events it
   * is about; the audit-coverage tests below assert those directly.
   */
  async function forgetHousekeeping() {
    await settleBackground();
    const housekeeping = await db
      .select({ id: events.id })
      .from(events)
      .where(like(events.type, "subscription.%"));
    for (const { id } of housekeeping) {
      await db.delete(eventDeliveries).where(eq(eventDeliveries.eventId, id));
      await db.delete(events).where(eq(events.id, id));
    }
  }

  async function addWebhook(
    input: {
      url?: string;
      events?: string[];
      secret?: string;
      name?: string;
    } = {},
  ) {
    const added = await EventSubscriptionService.add(asOwner(), {
      url: input.url ?? "https://hooks.example.net/every-app",
      events: input.events,
      secret: input.secret,
      name: input.name,
    });
    await forgetHousekeeping();
    return added;
  }

  const actor: EventActor = {
    kind: "user",
    id: "user-x",
    email: "ada@acme.example",
    name: "Ada",
  };

  function joined(organizationId = acme) {
    return {
      organizationId,
      actor,
      ...catalogue.memberJoined({
        user: { id: member, email: "cy@acme.example", name: "Cy" },
        role: "member",
        via: "invitation",
      }),
    };
  }

  async function deliveriesOf(subscriptionId: string) {
    return db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.subscriptionId, subscriptionId));
  }

  describe("emit", () => {
    it("writes one event and one delivery per matching enabled subscription, none for a disabled or non-matching one", async () => {
      const matching = await addWebhook({ events: ["member.*"] });
      const everything = await addWebhook({ url: "https://b.example.net/" });
      const other = await addWebhook({
        url: "https://c.example.net/",
        events: ["cap.*"],
      });
      const paused = await addWebhook({ url: "https://d.example.net/" });
      await EventSubscriptionService.update(asOwner(), paused.subscription.id, {
        enabled: false,
      });
      await forgetHousekeeping();

      await emit(joined());
      await settleBackground();

      const stored = await db.select().from(events);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        organizationId: acme,
        type: "member.joined",
        version: 1,
        dedupeKey: null,
      });
      expect(JSON.parse(stored[0]!.actor)).toEqual(actor);
      // The actor's kind and id as columns too, for the audit log's filter.
      expect(stored[0]).toMatchObject({ actorKind: "user", actorId: "user-x" });
      expect(await deliveriesOf(matching.subscription.id)).toHaveLength(1);
      expect(await deliveriesOf(everything.subscription.id)).toHaveLength(1);
      expect(await deliveriesOf(other.subscription.id)).toHaveLength(0);
      expect(await deliveriesOf(paused.subscription.id)).toHaveLength(0);
      // The first attempts ran after the response, and were delivered.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await deliveriesOf(matching.subscription.id)).toEqual([
        expect.objectContaining({ status: "delivered", attempts: 1 }),
      ]);
    });

    it("never queues an event for another organization's subscriptions (events.org-scoped)", async () => {
      const acmeHook = await addWebhook();
      await emit(joined(globex));
      await settleBackground();
      expect(await deliveriesOf(acmeHook.subscription.id)).toHaveLength(0);
      expect(await db.select().from(events)).toEqual([
        expect.objectContaining({ organizationId: globex }),
      ]);
    });

    it("emits an event with a dedupe key once across two emits", async () => {
      const hook = await addWebhook();
      const warning = () => ({
        organizationId: acme,
        actor: { kind: "gateway" } as const,
        ...catalogue.capWarning({
          organizationId: acme,
          app: { id: "crm", rowId: "app-row-1", name: "CRM" },
          kind: "calls",
          cap: 1000,
          calls: 800,
          costMicros: 0,
          month: "2026-10",
          source: "app",
        }),
      });
      const first = await queueEvent(warning());
      const second = await queueEvent(warning());
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(await db.select().from(events)).toHaveLength(1);
      expect(await deliveriesOf(hook.subscription.id)).toHaveLength(1);
    });

    it("never throws to the caller: a write that fails is logged as events.emit_failed", async () => {
      const spy = vi
        .spyOn(EventRepository, "insertWithDeliveries")
        .mockRejectedValueOnce(new Error("D1 is away"));
      const errors = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      await expect(emit(joined())).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        errors.mock.calls.some((call) =>
          String(call[0]).includes("events.emit_failed"),
        ),
      ).toBe(true);
    });

    it("refuses data with a key named like a credential before anything is written (events.no-secrets-no-tool-io)", async () => {
      await expect(
        queueEvent({
          organizationId: acme,
          actor,
          type: "app.crm.leaked",
          version: 1,
          data: { nested: { apiKey: "sk-live" } },
        }),
      ).rejects.toThrow(/apiKey/);
      expect(await db.select().from(events)).toHaveLength(0);
    });
  });

  describe("ping", () => {
    it("goes only to the tested subscription, even a paused one", async () => {
      const tested = await addWebhook({ url: "https://a.example.net/" });
      const other = await addWebhook({ url: "https://b.example.net/" });
      await EventSubscriptionService.update(asOwner(), tested.subscription.id, {
        enabled: false,
      });
      const { delivery } = await EventSubscriptionService.test(
        asOwner(),
        tested.subscription.id,
      );
      expect(delivery).toMatchObject({
        subscriptionId: tested.subscription.id,
        status: "delivered",
        attempts: 1,
        lastStatusCode: 200,
        event: expect.objectContaining({
          type: "ping",
          summary: "Test event from Every App",
        }),
      });
      expect(await deliveriesOf(other.subscription.id)).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("https://a.example.net/");
    });

    it("refuses to test another organization's subscription (events.org-scoped)", async () => {
      const hook = await addWebhook();
      await expect(
        EventSubscriptionService.test(
          { orgId: globex, userId: "user-9", role: "owner" },
          hook.subscription.id,
        ),
      ).rejects.toMatchObject({ code: "EVENT_SUBSCRIPTION_NOT_FOUND" });
    });
  });

  describe("the webhook delivery", () => {
    it("sends the exact headers and a signature the subscription's secret verifies and another refuses (events.signed-with-timestamp)", async () => {
      const { subscription, secret } = await addWebhook();
      expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      const queued = await emitAndWait(joined());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://hooks.example.net/every-app");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "manual",
      });
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const headers = init!.headers as Record<string, string>;
      const [delivery] = await deliveriesOf(subscription.id);
      expect(headers).toMatchObject({
        "content-type": "application/json",
        "user-agent": "every-app-gateway/1.2.3",
        [EVENT_HEADERS.event]: "member.joined",
        [EVENT_HEADERS.eventId]: queued!.id,
        [EVENT_HEADERS.delivery]: delivery!.id,
        [EVENT_HEADERS.attempt]: "1",
      });
      expect(headers[EVENT_HEADERS.signature]).toMatch(
        /^t=\d+,v1=[0-9a-f]{64}$/,
      );
      const body = init!.body as string;
      const envelope = JSON.parse(body);
      expect(envelope).toEqual({
        id: queued!.id,
        type: "member.joined",
        version: 1,
        summary: "cy@acme.example joined as member",
        time: clock.toISOString(),
        gateway: "https://gateway.example.com",
        organization: { id: acme, slug: "acme", name: "acme" },
        actor,
        data: {
          user: { id: member, email: "cy@acme.example", name: "Cy" },
          role: "member",
          via: "invitation",
        },
      });
      await expect(
        verifyEventSignature(secret!, headers[EVENT_HEADERS.signature], body, {
          now: clock,
        }),
      ).resolves.toEqual({ ok: true });
      await expect(
        verifyEventSignature(
          "whsec_another-secret-entirely",
          headers[EVENT_HEADERS.signature],
          body,
          { now: clock },
        ),
      ).resolves.toEqual({ ok: false, reason: "mismatch" });
      await expect(
        verifyEventSignature(secret!, headers[EVENT_HEADERS.signature], body, {
          now: new Date(clock.getTime() + 6 * 60_000),
        }),
      ).resolves.toEqual({ ok: false, reason: "expired" });
      await expect(
        verifyEventSignature(
          secret!,
          headers[EVENT_HEADERS.signature],
          `${body} `,
          {
            now: clock,
          },
        ),
      ).resolves.toEqual({ ok: false, reason: "mismatch" });
    });

    it("signs with the secret the person gave, and lists it nowhere (events.secret-shown-once)", async () => {
      const given = "my-own-secret-of-sixteen-plus";
      const { subscription, secret } = await addWebhook({ secret: given });
      expect(secret).toBeUndefined();
      expect(subscription).not.toHaveProperty("secret");
      const listed = await EventSubscriptionService.list(asOwner());
      expect(JSON.stringify(listed)).not.toContain(given);
      await emitAndWait(joined());
      const [, init] = fetchMock.mock.calls[0]!;
      const headers = init!.headers as Record<string, string>;
      await expect(
        verifyEventSignature(
          given,
          headers[EVENT_HEADERS.signature],
          init!.body as string,
          {
            now: clock,
          },
        ),
      ).resolves.toEqual({ ok: true });
    });

    it("a 2xx is delivered and the subscription notes it", async () => {
      const { subscription } = await addWebhook();
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await emitAndWait(joined());
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "delivered",
          attempts: 1,
          lastStatusCode: 204,
          lastError: null,
          nextAttemptAt: null,
          claimedUntil: null,
          deliveredAt: clock,
        }),
      ]);
      const { subscriptions } = await EventSubscriptionService.list(asOwner());
      expect(subscriptions[0]).toMatchObject({
        lastDeliveryStatus: "delivered",
        lastDeliveryAt: clock.toISOString(),
        consecutiveFailures: 0,
      });
    });

    it("a 500 retries after the first backoff and keeps 200 characters of the answer, never the body", async () => {
      const { subscription } = await addWebhook();
      fetchMock.mockResolvedValue(
        new Response(`boom ${"x".repeat(2000)}`, { status: 500 }),
      );
      await emitAndWait(joined());
      const [delivery] = await deliveriesOf(subscription.id);
      expect(delivery).toMatchObject({
        status: "pending",
        attempts: 1,
        lastStatusCode: 500,
        nextAttemptAt: new Date(clock.getTime() + EVENT_RETRY_DELAYS_MS[0]!),
        claimedUntil: null,
      });
      expect(delivery!.lastError).toMatch(/^status_500: boom x+$/);
      expect(delivery!.lastError!.length).toBeLessThanOrEqual(212);
      expect(delivery!.lastError).not.toContain("member.joined");
      const { subscriptions } = await EventSubscriptionService.list(asOwner());
      expect(subscriptions[0]).toMatchObject({
        lastDeliveryStatus: "failed",
        consecutiveFailures: 1,
      });
    });

    it("a 3xx is a failure with reason redirect and nothing is fetched at the Location (events.no-redirect-pinned-url)", async () => {
      const { subscription } = await addWebhook();
      fetchMock.mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.net/steal" },
        }),
      );
      await emitAndWait(joined());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(
        "https://hooks.example.net/every-app",
      );
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "pending",
          lastStatusCode: 302,
          lastError: "redirect",
        }),
      ]);
    });

    it("a 410 is dead at once", async () => {
      const { subscription } = await addWebhook();
      fetchMock.mockResolvedValue(new Response("gone", { status: 410 }));
      await emitAndWait(joined());
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "dead",
          attempts: 1,
          lastStatusCode: 410,
          lastError: "status_410: gone",
          nextAttemptAt: null,
        }),
      ]);
      const { subscriptions } = await EventSubscriptionService.list(asOwner());
      expect(subscriptions[0]).toMatchObject({ lastDeliveryStatus: "dead" });
    });

    it("a timeout retries", async () => {
      const { subscription } = await addWebhook();
      fetchMock.mockRejectedValue(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
      await emitAndWait(joined());
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "pending",
          lastStatusCode: null,
          lastError: "timeout",
        }),
      ]);
    });

    it("the seventh failure is dead, after the whole backoff schedule", async () => {
      const { subscription } = await addWebhook();
      fetchMock.mockResolvedValue(new Response("no", { status: 503 }));
      await emitAndWait(joined());
      const [first] = await deliveriesOf(subscription.id);
      for (
        let attempt = 2;
        attempt <= EVENT_DELIVERY_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const [row] = await deliveriesOf(subscription.id);
        expect(row!.status).toBe("pending");
        setClock(row!.nextAttemptAt!);
        expect(await deliverOnce(first!.id, deps)).toBe(
          attempt === EVENT_DELIVERY_MAX_ATTEMPTS ? "dead" : "failed",
        );
      }
      const [row] = await deliveriesOf(subscription.id);
      expect(row).toMatchObject({
        status: "dead",
        attempts: EVENT_DELIVERY_MAX_ATTEMPTS,
        nextAttemptAt: null,
      });
      expect(fetchMock).toHaveBeenCalledTimes(EVENT_DELIVERY_MAX_ATTEMPTS);
      const { subscriptions } = await EventSubscriptionService.list(asOwner());
      expect(subscriptions[0]).toMatchObject({
        lastDeliveryStatus: "dead",
        consecutiveFailures: EVENT_DELIVERY_MAX_ATTEMPTS,
      });
    });

    it("checks the target again before each attempt, so a URL the rules now refuse is not fetched (events.target-rules)", async () => {
      const { subscription } = await addWebhook();
      await db
        .update(eventSubscriptions)
        .set({ url: "https://gateway.example.com/hook" })
        .where(eq(eventSubscriptions.id, subscription.id));
      await emitAndWait(joined());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "pending",
          lastError: "target_refused: gateway_host",
        }),
      ]);
    });

    it("a delivery whose subscription was removed is dead with subscription_gone", async () => {
      const { subscription } = await addWebhook();
      const queued = await queueEvent(joined());
      await EventSubscriptionService.remove(asOwner(), subscription.id);
      await attemptDeliveries(queued!.deliveryIds, deps);
      expect(fetchMock).not.toHaveBeenCalled();
      const [row] = await db
        .select()
        .from(eventDeliveries)
        .where(eq(eventDeliveries.id, queued!.deliveryIds[0]!));
      expect(row).toMatchObject({
        status: "dead",
        lastError: "subscription_gone",
      });
    });
  });

  describe("the sweep", () => {
    it("claims a due row once under two concurrent sweeps", async () => {
      const { subscription } = await addWebhook();
      const queued = await queueEvent(joined());
      let release: () => void = () => undefined;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(new Response("ok", { status: 200 }));
          }),
      );
      const first = sweep(deps);
      const second = sweep(deps);
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.delivered + b.delivered).toBe(1);
      expect(a.skipped + b.skipped).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          id: queued!.deliveryIds[0],
          status: "delivered",
          attempts: 1,
        }),
      ]);
    });

    it("attempts only rows whose time has come, soonest first, and leaves the rest", async () => {
      await addWebhook();
      fetchMock.mockResolvedValue(new Response("no", { status: 500 }));
      await emitAndWait(joined());
      fetchMock.mockClear();
      // Not yet due: one minute has to pass.
      await expect(sweep(deps)).resolves.toMatchObject({ due: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      setClock(new Date(clock.getTime() + EVENT_RETRY_DELAYS_MS[0]!));
      await expect(sweep(deps)).resolves.toMatchObject({ due: 1, failed: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0]!;
      expect(
        (init!.headers as Record<string, string>)[EVENT_HEADERS.attempt],
      ).toBe("2");
    });
  });

  describe("the app emit rate (events.app-emit-attributed-and-bounded)", () => {
    it("decides on the write, so concurrent emits at the limit let exactly one through", async () => {
      const deps = await loadAppEmitDeps();
      const hour = clock.toISOString().slice(0, 13);
      await db.insert(rateLimitCounters).values({
        key: `events:emit:row-1:${hour}`,
        count: APP_EVENT_RATE_PER_HOUR - 1,
        expiresAt: new Date(clock.getTime() + 60 * 60 * 1000),
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => deps.countEmit("row-1", clock)),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(1);
      const refused = results.find((result) => !result.allowed)!;
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60 * 60);
      // The next hour starts over.
      const later = new Date(clock.getTime() + 60 * 60 * 1000);
      await expect(deps.countEmit("row-1", later)).resolves.toMatchObject({
        allowed: true,
      });
    });
  });

  describe("redeliver", () => {
    it("resets a dead row to pending with the attempts starting over, and sends it", async () => {
      const { subscription } = await addWebhook();
      fetchMock.mockResolvedValue(new Response("gone", { status: 410 }));
      await emitAndWait(joined());
      const [dead] = await deliveriesOf(subscription.id);
      expect(dead!.status).toBe("dead");
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      const { delivery } = await EventSubscriptionService.redeliver(
        asOwner(),
        dead!.id,
      );
      expect(delivery).toMatchObject({
        id: dead!.id,
        status: "delivered",
        attempts: 1,
        redeliveredAt: clock.toISOString(),
      });
    });

    it("refuses another organization's delivery (events.org-scoped)", async () => {
      await addWebhook();
      fetchMock.mockResolvedValue(new Response("gone", { status: 410 }));
      const queued = await emitAndWait(joined());
      await expect(
        EventSubscriptionService.redeliver(
          { orgId: globex, userId: "user-9", role: "owner" },
          queued!.deliveryIds[0]!,
        ),
      ).rejects.toMatchObject({ code: "EVENT_DELIVERY_NOT_FOUND" });
      await expect(
        EventSubscriptionService.deliveries(
          { orgId: globex, userId: "user-9", role: "owner" },
          {},
        ),
      ).resolves.toEqual({ deliveries: [], nextCursor: null });
    });
  });

  describe("the email sink", () => {
    async function addEmail(recipients: "owners" | "admins" = "admins") {
      const added = await EventSubscriptionService.add(asOwner(), {
        email: recipients,
      });
      await forgetHousekeeping();
      return added;
    }

    it("mails each live owner and admin once and nobody else, counting the recipients (events.email-sink-members-only)", async () => {
      const { subscription } = await addEmail("admins");
      await seedMember(db, {
        organizationId: acme,
        role: "admin",
        email: "gone@acme.example",
        banned: true,
      });
      await emitAndWait(joined());
      const recipients = sendMock.mock.calls.map((call) => call[0].to).sort();
      expect(recipients).toEqual(["ada@acme.example", "bo@acme.example"]);
      for (const [options] of sendMock.mock.calls) {
        expect(options).toMatchObject({
          kind: "notice",
          subject: "[acme] cy@acme.example joined as member",
        });
        expect(options.text).toContain(
          "https://gateway.example.com/admin/users",
        );
        expect(options.html).toContain("Cy (cy@acme.example)");
        expect(options.text).not.toContain(member);
      }
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({ status: "delivered", lastStatusCode: 2 }),
      ]);
    });

    it("mails owners only when the subscription says owners", async () => {
      await addEmail("owners");
      await emitAndWait(joined());
      expect(sendMock.mock.calls.map((call) => call[0].to)).toEqual([
        "ada@acme.example",
      ]);
    });

    it("is dead at once with email_not_configured when the gateway can't send", async () => {
      const { subscription } = await addEmail();
      emailConfigured = false;
      await emitAndWait(joined());
      expect(sendMock).not.toHaveBeenCalled();
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "dead",
          lastError: "email_not_configured",
        }),
      ]);
    });

    it("retries with email_budget_exhausted when every send was refused for budget", async () => {
      const { subscription } = await addEmail();
      sendMock.mockRejectedValue(
        Object.assign(new Error("spent"), { code: "EMAIL_BUDGET_EXHAUSTED" }),
      );
      await emitAndWait(joined());
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "pending",
          lastStatusCode: 0,
          lastError: "email_budget_exhausted",
        }),
      ]);
    });

    it("a recipient whose send was refused is retried, without mailing the others again, and the delivery is made once everyone has it", async () => {
      const { subscription } = await addEmail();
      let refusedOnce = false;
      sendMock.mockImplementation(async (options) => {
        if (options.to === "ada@acme.example" && !refusedOnce) {
          refusedOnce = true;
          throw Object.assign(new Error("spent"), {
            code: "EMAIL_BUDGET_EXHAUSTED",
          });
        }
        return { status: "delivered" };
      });
      await emitAndWait(joined());
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "pending",
          attempts: 1,
          lastStatusCode: 1,
          lastError: "partial: 1 of 2 mailed; email_budget_exhausted",
        }),
      ]);
      expect(sendMock.mock.calls.map((call) => call[0].to).sort()).toEqual([
        "ada@acme.example",
        "bo@acme.example",
      ]);
      sendMock.mockClear();
      setClock(new Date(clock.getTime() + EVENT_RETRY_DELAYS_MS[0]! + 1000));
      await sweep(deps);
      expect(sendMock.mock.calls.map((call) => call[0].to)).toEqual([
        "ada@acme.example",
      ]);
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({
          status: "delivered",
          attempts: 2,
          lastStatusCode: 2,
          lastError: null,
        }),
      ]);
    });

    it("a redeliver more than three days after a partial send mails every recipient again (the limit events.email-sink-members-only names)", async () => {
      const { subscription } = await addEmail();
      let refuseBo = true;
      sendMock.mockImplementation(async (options) => {
        if (options.to === "bo@acme.example" && refuseBo) {
          throw Object.assign(new Error("spent"), {
            code: "EMAIL_BUDGET_EXHAUSTED",
          });
        }
        return { status: "delivered" };
      });
      await emitAndWait(joined());
      const mailedAt = clock;
      const [first] = await deliveriesOf(subscription.id);
      for (
        let attempt = 2;
        attempt <= EVENT_DELIVERY_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const [row] = await deliveriesOf(subscription.id);
        setClock(row!.nextAttemptAt!);
        await deliverOnce(first!.id, deps);
      }
      const [dead] = await deliveriesOf(subscription.id);
      expect(dead!.status).toBe("dead");
      // The whole schedule (about 35 hours) sits inside the marker's three
      // days: Ada was mailed once and every attempt since tried Bo alone.
      expect(
        sendMock.mock.calls.filter((call) => call[0].to === "ada@acme.example"),
      ).toHaveLength(1);
      sendMock.mockClear();
      await EventSubscriptionService.redeliver(asOwner(), dead!.id);
      expect(sendMock.mock.calls.map((call) => call[0].to)).toEqual([
        "bo@acme.example",
      ]);
      // Past three days the marker has expired and a redeliver starts over:
      // Ada gets the mail a second time.
      sendMock.mockClear();
      refuseBo = false;
      setClock(new Date(mailedAt.getTime() + 3 * 24 * 60 * 60 * 1000 + 1000));
      await EventSubscriptionService.redeliver(asOwner(), dead!.id);
      expect(sendMock.mock.calls.map((call) => call[0].to).sort()).toEqual([
        "ada@acme.example",
        "bo@acme.example",
      ]);
      expect(await deliveriesOf(subscription.id)).toEqual([
        expect.objectContaining({ status: "delivered", lastStatusCode: 2 }),
      ]);
    });
  });

  describe("subscriptions", () => {
    it("refuses the 26th subscription and a sink with both a URL and email", async () => {
      for (let index = 0; index < 25; index += 1) {
        await addWebhook({ url: `https://h${index}.example.net/` });
      }
      await expect(
        addWebhook({ url: "https://h25.example.net/" }),
      ).rejects.toMatchObject({
        code: "EVENT_SUBSCRIPTIONS_LIMIT",
      });
      await expect(
        EventSubscriptionService.add(asOwner(), {
          url: "https://h.example.net/",
          email: "owners",
        }),
      ).rejects.toMatchObject({ code: "EVENT_SINK_CONFLICT" });
    });

    it("refuses a pattern that matches nothing and a secret of the wrong length", async () => {
      await expect(
        addWebhook({ events: ["member.joinde"] }),
      ).rejects.toMatchObject({
        code: "EVENT_TYPE_UNKNOWN",
      });
      await expect(addWebhook({ events: ["nothing.*"] })).rejects.toMatchObject(
        {
          code: "EVENT_TYPE_UNKNOWN",
        },
      );
      await expect(addWebhook({ secret: "short" })).rejects.toMatchObject({
        code: "EVENT_SECRET_INVALID",
      });
      await expect(
        addWebhook({ events: ["app.crm.*", "member.joined", "*"] }),
      ).resolves.toMatchObject({
        subscription: { events: ["app.crm.*", "member.joined", "*"] },
      });
    });

    it("refuses a target the rules refuse, naming why", async () => {
      await expect(
        addWebhook({ url: "http://hooks.example.net/" }),
      ).rejects.toMatchObject({
        code: "EVENT_TARGET_REFUSED",
      });
      await expect(
        addWebhook({ url: "https://crm.gateway.example.com/hook" }),
      ).rejects.toMatchObject({ code: "EVENT_TARGET_REFUSED" });
    });

    it("disables a built-in subscription instead of removing it, and lists another organization nothing", async () => {
      await EventSubscriptionService.ensureCapAlerts(acme);
      await EventSubscriptionService.ensureCapAlerts(acme);
      const { subscriptions } = await EventSubscriptionService.list(asOwner());
      expect(subscriptions).toEqual([
        expect.objectContaining({
          name: "Cap alerts",
          sink: "email",
          recipients: "admins",
          builtin: "cap_alerts",
          events: ["cap.warning", "cap.reached"],
          enabled: true,
        }),
      ]);
      await expect(
        EventSubscriptionService.remove(asOwner(), subscriptions[0]!.id),
      ).resolves.toEqual({ removed: false, disabled: true });
      const after = await EventSubscriptionService.list(asOwner());
      expect(after.subscriptions).toEqual([
        expect.objectContaining({ builtin: "cap_alerts", enabled: false }),
      ]);
      await expect(
        EventSubscriptionService.list({
          orgId: globex,
          userId: "u",
          role: "owner",
        }),
      ).resolves.toEqual({ subscriptions: [] });
    });

    it("pages deliveries newest first with a cursor and a dead filter", async () => {
      await addWebhook();
      fetchMock.mockResolvedValue(new Response("gone", { status: 410 }));
      for (let index = 0; index < 3; index += 1) {
        setClock(new Date(clock.getTime() + 1000));
        await emitAndWait(joined());
      }
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      setClock(new Date(clock.getTime() + 1000));
      await emitAndWait(joined());
      const page = await EventSubscriptionService.deliveries(asOwner(), {
        limit: 2,
      });
      expect(page.deliveries).toHaveLength(2);
      expect(page.deliveries[0]!.status).toBe("delivered");
      expect(page.nextCursor).not.toBeNull();
      const next = await EventSubscriptionService.deliveries(asOwner(), {
        limit: 2,
        before: page.nextCursor!,
      });
      expect(next.deliveries).toHaveLength(2);
      expect(
        new Set([...page.deliveries, ...next.deliveries].map((d) => d.id)).size,
      ).toBe(4);
      const dead = await EventSubscriptionService.deliveries(asOwner(), {
        status: "dead",
      });
      expect(dead.deliveries).toHaveLength(3);
      expect(dead.deliveries.every((d) => d.status === "dead")).toBe(true);
      expect(dead.deliveries[0]!.event).toMatchObject({
        type: "member.joined",
        summary: "cy@acme.example joined as member",
      });
    });
  });

  describe("target rules (events.target-rules)", () => {
    const rules = {
      allowPrivate: false,
      gatewayHosts: ["gateway.example.com"],
    };
    const open = { ...rules, allowPrivate: true };

    it.each([
      ["http://hooks.example.net/", "not_https"],
      ["ftp://hooks.example.net/", "scheme"],
      ["not a url", "not_a_url"],
      ["https://127.0.0.1/hook", "ip_literal"],
      ["https://[::1]/hook", "ip_literal"],
      ["https://localhost/hook", "private_host"],
      ["https://n8n.localhost/hook", "private_host"],
      ["https://box.local/hook", "private_host"],
      ["https://svc.internal/hook", "private_host"],
      ["https://nas.home.arpa/hook", "private_host"],
      ["https://abc.onion/hook", "private_host"],
      ["https://intranet-box/hook", "private_host"],
      ["https://gateway.example.com/hook", "gateway_host"],
      ["https://crm.gateway.example.com/hook", "gateway_host"],
      ["https://user:pw@hooks.example.net/", "userinfo"],
      ["https://hooks.example.net/#frag", "fragment"],
      [`https://hooks.example.net/${"a".repeat(2100)}`, "too_long"],
    ])("refuses %s as %s", (url, reason) => {
      expect(checkTarget(url, rules)).toMatchObject({ ok: false, reason });
    });

    it("allows https to a public hostname, with a port, path and query", () => {
      expect(
        checkTarget("https://hooks.slack.com:8443/services/T/B/x?y=1", rules),
      ).toEqual({ ok: true });
    });

    it("allows http and private hosts only with the flag, and the gateway's own hosts never", () => {
      expect(checkTarget("http://n8n.internal/hook", open)).toEqual({
        ok: true,
      });
      expect(checkTarget("https://10.0.0.5/hook", open)).toEqual({ ok: true });
      expect(checkTarget("http://localhost:5678/hook", open)).toEqual({
        ok: true,
      });
      expect(
        checkTarget("https://gateway.example.com/hook", open),
      ).toMatchObject({
        ok: false,
        reason: "gateway_host",
      });
      expect(
        checkTarget("http://crm.gateway.example.com/hook", open),
      ).toMatchObject({
        ok: false,
        reason: "gateway_host",
      });
    });
  });

  describe("retention (events.retention)", () => {
    it("the hourly maintenance deletes deliveries past 30 days and events past 90 (the audit log), and keeps newer ones", async () => {
      await addWebhook();
      // Past both: gone with its delivery.
      await emitAndWait(joined());
      const ancient = new Date(
        clock.getTime() - (AUDIT_RETENTION_DAYS + 1) * 86_400_000,
      );
      await db.update(events).set({ time: ancient });
      await db.update(eventDeliveries).set({ createdAt: ancient });
      // Past the deliveries' 30 days only: the event stays for the audit log.
      const aged = new Date(
        clock.getTime() - (EVENT_RETENTION_DAYS + 1) * 86_400_000,
      );
      const middle = await emitAndWait(joined());
      await db
        .update(events)
        .set({ time: aged })
        .where(eq(events.id, middle!.id));
      await db
        .update(eventDeliveries)
        .set({ createdAt: aged })
        .where(eq(eventDeliveries.eventId, middle!.id));
      const fresh = await emitAndWait(joined());
      expect(await db.select().from(events)).toHaveLength(3);
      await runMcpMaintenance(
        { OAUTH_KV: { get: async () => null } } as unknown as Cloudflare.Env,
        clock,
      );
      expect(
        (await db.select().from(events)).map((row) => row.id).sort(),
      ).toEqual([middle!.id, fresh!.id].sort());
      expect(
        (await db.select().from(eventDeliveries)).map((row) => row.eventId),
      ).toEqual([fresh!.id]);
    });
  });

  describe("the catalogue (events.no-secrets-no-tool-io)", () => {
    const user = { id: "user-1", email: "jo@acme.example", name: "Jo" };
    const app = { id: "crm", rowId: "row-1", name: "CRM" };
    const cap = {
      organizationId: "org",
      app,
      kind: "calls" as const,
      cap: 1000,
      calls: 800,
      costMicros: 0,
      month: "2026-10",
      source: "app" as const,
    };
    const samples: Record<string, ReturnType<typeof catalogue.ping>> = {
      "member.invited": catalogue.memberInvited({
        invitation: {
          id: "inv",
          email: "jo@acme.example",
          role: "member",
          expiresAt: new Date(0),
        },
        emailSent: true,
      }),
      "member.joined": catalogue.memberJoined({
        user,
        role: "member",
        via: "invitation",
      }),
      "member.role_changed": catalogue.memberRoleChanged({
        user,
        role: "admin",
        previousRole: "member",
      }),
      "member.deactivated": catalogue.memberDeactivated({
        user,
        reason: "left",
      }),
      "member.reactivated": catalogue.memberReactivated({ user }),
      "member.removed": catalogue.memberRemoved({ user, accountDeleted: true }),
      "member.password_reset": catalogue.memberPasswordReset({
        user,
        by: "self",
      }),
      "app.installed": catalogue.appInstalled({
        app,
        version: "v1",
        hostname: "crm.x",
        scope: "org",
        source: "cli",
      }),
      "app.updated": catalogue.appUpdated({
        app,
        version: "v2",
        previousVersion: "v1",
      }),
      "app.removed": catalogue.appRemoved({ app, purged: false }),
      "app.needs_setup": catalogue.appNeedsSetup({
        app,
        unmet: ["OPENROUTER_API_KEY"],
      }),
      "app.ready": catalogue.appReady({ app }),
      "app.paused_cap": catalogue.appPausedCap({ ...cap, calls: 1000 }),
      "app.tools_changed": catalogue.appToolsChanged({
        app,
        kind: "app",
        toolCount: 12,
        previousToolCount: 11,
        added: ["a"],
        removed: [],
      }),
      "cap.warning": catalogue.capWarning(cap),
      "cap.reached": catalogue.capReached({ ...cap, calls: 1000 }),
      "cap.raised": catalogue.capRaised({
        app,
        cap: 5000,
        previousCap: 1000,
        source: "app",
      }),
      "tool.blocked": catalogue.toolBlocked({
        tool: "crm_delete_contact",
        app,
        user,
        client: { kind: "oauth", name: "Claude", id: "conn-1" },
        risk: "destructive",
        reason: "destructive",
        callId: "c1",
      }),
      "tool.error": catalogue.toolError({
        tool: "crm_list_contacts",
        app,
        user,
        client: { kind: "oauth", name: "Claude", id: "conn-1" },
        outcome: "app_error",
        callId: "c2",
        durationMs: 12,
      }),
      "connection.created": catalogue.connectionCreated({
        connection: {
          id: "conn-1",
          clientName: "Claude",
          clientDomain: "claude.ai",
          access: "write",
          appScope: "all",
        },
        user,
      }),
      "connection.revoked": catalogue.connectionRevoked({
        connection: { id: "conn-1", clientName: "Claude" },
        user,
        reason: "user",
      }),
      "token.created": catalogue.tokenCreated({
        id: "t1",
        name: "ci-deploy",
        scopes: ["*"],
        expiresAt: new Date(0),
        user,
      }),
      "token.revoked": catalogue.tokenRevoked({
        id: "t1",
        name: "ci-deploy",
        user,
      }),
      "access.changed": catalogue.accessChanged({
        access: "on",
        teamDomain: "acme.cloudflareaccess.com",
      }),
      "signin_provider.added": catalogue.signInProviderAdded({
        provider: "google",
        label: "Google",
      }),
      "signin_provider.removed": catalogue.signInProviderRemoved({
        provider: "google",
        label: "Google",
      }),
      "mcp_app.added": catalogue.mcpAppAdded({ app, kind: "builtin" }),
      "mcp_app.removed": catalogue.mcpAppRemoved({ app, kind: "builtin" }),
      "mcp_app.enabled": catalogue.mcpAppEnabled({ app, kind: "builtin" }),
      "mcp_app.disabled": catalogue.mcpAppDisabled({ app, kind: "remote" }),
      "provider.added": catalogue.providerAdded({
        provider: { id: "p", name: "P" },
      }),
      "provider.removed": catalogue.providerRemoved({
        provider: { id: "p", name: "P" },
      }),
      "member.invitation_cancelled": catalogue.memberInvitationCancelled({
        invitation: { id: "inv-1", email: "jo@acme.example", role: "member" },
      }),
      "organization.renamed": catalogue.organizationRenamed({
        name: "Acme Corp",
        previousName: "Acme",
      }),
      "app.renamed": catalogue.appRenamed({
        app,
        previousName: "Old CRM",
        description: "Contacts",
      }),
      "app.settings_changed": catalogue.appSettingsChanged({
        app,
        settings: ["OPENROUTER_API_KEY"],
        action: "set",
        target: "gateway",
      }),
      "app.access_changed": catalogue.appAccessChanged({
        app,
        granted: [user],
        revoked: [],
      }),
      "app.email_changed": catalogue.appEmailChanged({
        app,
        senders: ["hello"],
        inbound: ["support"],
      }),
      "cap.changed": catalogue.capChanged({
        app,
        cap: 500,
        previousCap: 1000,
        source: "app",
      }),
      "group.created": catalogue.groupCreated({
        group: { id: "grp_1", name: "Sales" },
        description: "The sales team",
      }),
      "group.updated": catalogue.groupUpdated({
        group: { id: "grp_1", name: "Sales EMEA" },
        previousName: "Sales",
      }),
      "group.removed": catalogue.groupRemoved({
        group: { id: "grp_1", name: "Sales" },
      }),
      "group.members_changed": catalogue.groupMembersChanged({
        group: { id: "grp_1", name: "Sales" },
        added: [user],
        removed: [],
      }),
      "group.apps_changed": catalogue.groupAppsChanged({
        group: { id: "grp_1", name: "Sales" },
        granted: [app],
        revoked: [],
      }),
      "mcp_app.updated": catalogue.mcpAppUpdated({
        app,
        kind: "remote",
        changed: ["risk"],
        risk: "write",
      }),
      "mcp_app.tool_changed": catalogue.mcpAppToolChanged({
        app,
        kind: "remote",
        tool: "delete_row",
        risk: "destructive",
        enabled: false,
      }),
      "subscription.created": catalogue.subscriptionCreated({
        subscription: { id: "sub_x", name: "Slack", sink: "webhook" },
        events: ["member.*"],
        host: "hooks.example.net",
      }),
      "subscription.updated": catalogue.subscriptionUpdated({
        subscription: { id: "sub_x", name: "Slack", sink: "webhook" },
        changed: ["enabled"],
        enabled: false,
      }),
      "subscription.removed": catalogue.subscriptionRemoved({
        subscription: { id: "sub_x", name: "Slack", sink: "webhook" },
        disabled: false,
      }),
      "subscription.redelivered": catalogue.subscriptionRedelivered({
        subscription: { id: "sub_x", name: "Slack", sink: "webhook" },
        delivery: { id: "dlv_1", eventId: "evt_1", eventType: "member.joined" },
      }),
      "provider.updated": catalogue.providerUpdated({
        provider: { id: "github", name: "GitHub", kind: "oauth" },
        change: "client",
      }),
      "provider.connected": catalogue.providerConnected({
        provider: { id: "github", name: "GitHub", kind: "oauth" },
        account: {
          kind: "user",
          user: { id: "u2", email: "jo@acme.example" },
          label: "jo",
        },
        scopeSets: ["identity", "repo.read"],
      }),
      "provider.disconnected": catalogue.providerDisconnected({
        provider: { id: "github", name: "GitHub", kind: "oauth" },
        account: { kind: "organization", label: "acme" },
        revoked: true,
      }),
      "provider.connection_expired": catalogue.providerConnectionExpired({
        provider: { id: "github", name: "GitHub", kind: "oauth" },
        account: { kind: "user", user: { id: "u2", email: "jo@acme.example" } },
        connectionId: "conn_1",
      }),
      "ai.default_changed": catalogue.aiDefaultChanged({
        aiDefault: {
          provider: "openrouter",
          model: "anthropic/claude-haiku-5.5",
        },
        previous: null,
      }),
      ping: catalogue.ping({ subscription: { id: "sub_x", name: "Slack" } }),
    };

    function keysOf(value: unknown, found: string[] = []): string[] {
      if (Array.isArray(value)) value.forEach((item) => keysOf(item, found));
      else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          found.push(key);
          keysOf(inner, found);
        }
      }
      return found;
    }

    it("has a builder for every type whose output passes the data check and names no credential-like key", () => {
      for (const info of EVENT_TYPES) {
        const built = samples[info.type];
        expect(built, info.type).toBeDefined();
        expect(built!.type).toBe(info.type);
        expect(built!.version).toBe(info.version);
        expect(
          checkEventData(built!.data, EVENT_DATA_MAX_BYTES),
          info.type,
        ).toMatchObject({ ok: true });
        for (const key of keysOf(built!.data)) {
          expect(CREDENTIAL_KEY_PATTERN.test(key), `${info.type}: ${key}`).toBe(
            false,
          );
        }
      }
      expect(Object.keys(samples).sort()).toEqual(
        EVENT_TYPES.map((i) => i.type).sort(),
      );
    });

    it("writes the contract's summary lines", () => {
      const ada: EventActor = {
        kind: "user",
        id: "u",
        email: "ada@acme.example",
        name: "Ada",
      };
      const line = (type: string) => summarize(type, samples[type]!.data, ada);
      expect(line("member.invited")).toBe(
        "Ada invited jo@acme.example as member",
      );
      expect(line("member.joined")).toBe("jo@acme.example joined as member");
      expect(line("member.role_changed")).toBe("jo@acme.example is now admin");
      expect(line("member.deactivated")).toBe(
        "jo@acme.example was deactivated",
      );
      expect(line("member.removed")).toBe("jo@acme.example was removed");
      expect(line("member.password_reset")).toBe(
        "jo@acme.example reset their password",
      );
      expect(line("app.installed")).toBe("CRM was installed");
      expect(line("app.updated")).toBe("CRM was redeployed (version v2)");
      expect(line("app.needs_setup")).toBe(
        "CRM needs setup: OPENROUTER_API_KEY",
      );
      expect(line("app.ready")).toBe("CRM is ready");
      expect(line("app.paused_cap")).toBe(
        "CRM is paused: monthly cap of 1,000 reached",
      );
      expect(line("app.tools_changed")).toBe(
        "CRM's tools changed: 12 tools (was 11)",
      );
      expect(line("cap.warning")).toBe(
        "CRM is at 80% of its monthly cap (800 of 1,000)",
      );
      expect(line("cap.reached")).toBe("CRM reached its monthly cap (1,000)");
      expect(line("cap.raised")).toBe("CRM's cap raised from 1,000 to 5,000");
      // The workspace default names no app.
      expect(
        summarize(
          "cap.raised",
          { app: null, cap: 1000, previousCap: null, source: "default" },
          ada,
        ),
      ).toBe("The default cap set to 1,000");
      expect(
        summarize(
          "cap.raised",
          { app: null, cap: null, previousCap: 1000, source: "default" },
          ada,
        ),
      ).toBe("The default cap was removed (was 1,000)");
      expect(line("tool.blocked")).toBe(
        "Claude's call to crm_delete_contact was blocked: destructive",
      );
      expect(line("tool.error")).toBe(
        "crm_list_contacts failed for Claude: app_error",
      );
      expect(line("connection.created")).toBe(
        "Ada connected Claude (read & write, all apps)",
      );
      expect(line("connection.revoked")).toBe(
        "jo@acme.example's Claude connection was revoked (user)",
      );
      expect(line("token.created")).toBe("Ada created the token ci-deploy");
      expect(line("token.revoked")).toBe("Ada revoked the token ci-deploy");
      expect(line("access.changed")).toBe("Cloudflare Access was turned on");
      expect(line("signin_provider.added")).toBe("Google sign-in was added");
      expect(line("signin_provider.removed")).toBe(
        "Google sign-in was removed",
      );
      expect(line("mcp_app.added")).toBe("CRM was added as an MCP app");
      expect(line("provider.updated")).toBe(
        "GitHub's OAuth client was replaced",
      );
      expect(line("provider.connected")).toBe(
        "jo@acme.example connected GitHub",
      );
      expect(line("provider.disconnected")).toBe(
        "The workspace's GitHub account was disconnected",
      );
      expect(line("provider.connection_expired")).toBe(
        "jo@acme.example's GitHub connection expired and needs reconnecting",
      );
      expect(samples["provider.connection_expired"]!.dedupeKey).toBe(
        "provider.connection_expired:conn_1",
      );
      expect(line("ping")).toBe("Test event from Every App");
      expect(line("member.invitation_cancelled")).toBe(
        "Ada cancelled the invitation for jo@acme.example",
      );
      expect(line("organization.renamed")).toBe(
        "Ada renamed the workspace to Acme Corp",
      );
      expect(line("app.renamed")).toBe("Old CRM was renamed to CRM");
      expect(line("app.settings_changed")).toBe(
        "CRM's settings set: OPENROUTER_API_KEY",
      );
      expect(line("app.access_changed")).toBe(
        "CRM's access changed: 1 granted",
      );
      expect(line("app.email_changed")).toBe(
        "CRM's email changed: 1 sender, 1 inbound",
      );
      expect(line("cap.changed")).toBe("CRM's cap lowered from 1,000 to 500");
      expect(line("group.created")).toBe("Ada created the group Sales");
      expect(line("group.updated")).toBe(
        "The group Sales was renamed to Sales EMEA",
      );
      expect(line("group.removed")).toBe("The group Sales was removed");
      expect(line("group.members_changed")).toBe(
        "The group Sales's members changed: 1 added, 0 removed",
      );
      expect(line("group.apps_changed")).toBe(
        "The group Sales's apps changed: 1 granted, 0 revoked",
      );
      expect(line("mcp_app.updated")).toBe("CRM was changed: risk");
      expect(line("mcp_app.tool_changed")).toBe(
        "CRM's tool delete_row was changed (off) (risk destructive)",
      );
      expect(line("subscription.created")).toBe(
        "Ada added the subscription Slack",
      );
      expect(line("subscription.updated")).toBe(
        "The subscription Slack was paused",
      );
      expect(line("subscription.removed")).toBe(
        "The subscription Slack was removed",
      );
      expect(line("subscription.redelivered")).toBe(
        "Ada redelivered member.joined to Slack",
      );
      // An agent names its connection; a token with no client name, the member it acts for.
      const claude: EventActor = {
        kind: "agent",
        id: "conn-1",
        name: "Claude",
        email: "ada@acme.example",
      };
      expect(
        summarize("group.created", samples["group.created"]!.data, claude),
      ).toBe("Claude created the group Sales");
      expect(
        summarize("group.created", samples["group.created"]!.data, {
          kind: "agent",
          id: "pat-1",
          email: "ada@acme.example",
        }),
      ).toBe("ada@acme.example created the group Sales");
      expect(summarize("app.crm.invoice.paid", { total: 1 }, ada)).toBe(
        "crm: invoice.paid",
      );
    });

    it("keeps the dedupe keys per organization, app row, month, kind and cap", () => {
      expect(samples["cap.warning"]!.dedupeKey).toBe(
        "cap.warning:org:row-1:2026-10:calls:1000:80",
      );
      expect(samples["cap.reached"]!.dedupeKey).toBe(
        "cap.reached:org:row-1:2026-10:calls:1000",
      );
      expect(samples["app.paused_cap"]!.dedupeKey).toBe(
        "app.paused_cap:org:row-1:2026-10:calls:1000",
      );
      // The dollar cap is announced on its own, under its own key.
      const dollars = { ...cap, kind: "cost" as const, cap: 20_000_000 };
      expect(catalogue.capReached(dollars).dedupeKey).toBe(
        "cap.reached:org:row-1:2026-10:cost:20000000",
      );
      expect(samples["member.joined"]!.dedupeKey).toBeUndefined();
    });

    it("writes the dollar cap's lines and mail fields in dollars", () => {
      const dollars = {
        ...cap,
        kind: "cost" as const,
        cap: 20_000_000,
        costMicros: 16_250_000,
      };
      const warning = catalogue.capWarning(dollars);
      expect(warning.data).toEqual({
        app,
        kind: "cost",
        costCap: 20,
        cost: 16.25,
        calls: 800,
        month: "2026-10",
        threshold: 80,
        source: "app",
      });
      expect(summarize("cap.warning", warning.data, null)).toBe(
        "CRM is at 80% of its monthly dollar cap ($16.25 of $20.00)",
      );
      expect(
        summarize("cap.reached", catalogue.capReached(dollars).data, null),
      ).toBe("CRM reached its monthly dollar cap ($20.00)");
      expect(
        summarize("app.paused_cap", catalogue.appPausedCap(dollars).data, null),
      ).toBe("CRM is paused: monthly dollar cap of $20.00 reached");
      expect(eventEmailFields("cap.warning", warning.data)).toEqual(
        expect.arrayContaining([
          { label: "Dollar cap", value: "$20.00" },
          { label: "Cost this month", value: "$16.25" },
        ]),
      );
      const raised = (data: Parameters<typeof catalogue.capRaised>[0]) =>
        summarize("cap.raised", catalogue.capRaised(data).data, null);
      expect(
        raised({
          app: null,
          cap: 1000,
          previousCap: 1000,
          costCap: 50,
          previousCostCap: 20,
          source: "default",
        }),
      ).toBe("The default dollar cap raised from $20.00 to $50.00");
      expect(
        raised({
          app,
          cap: 2000,
          previousCap: 1000,
          costCap: null,
          previousCostCap: 20,
          source: "app",
        }),
      ).toBe(
        "CRM's cap raised from 1,000 to 2,000; its dollar cap was removed (was $20.00)",
      );
    });

    it("keeps token.created and token.revoked flat: a key named token is one the credential rule refuses", () => {
      expect(Object.keys(samples["token.created"]!.data).sort()).toEqual([
        "expiresAt",
        "id",
        "name",
        "scopes",
        "user",
      ]);
      expect(Object.keys(samples["token.revoked"]!.data).sort()).toEqual([
        "id",
        "name",
        "user",
      ]);
      expect(CREDENTIAL_KEY_PATTERN.test("token")).toBe(true);
    });

    it("generates secrets of the documented shape", () => {
      const a = generateSecret();
      const b = generateSecret();
      expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      expect(a).not.toBe(b);
    });
  });

  describe("emit points (each fires once)", () => {
    async function typesEmitted(organizationId = acme) {
      const rows = await db
        .select({ type: events.type, data: events.data, actor: events.actor })
        .from(events)
        .where(eq(events.organizationId, organizationId));
      return rows.map((row) => ({
        type: row.type,
        data: JSON.parse(row.data) as Record<string, unknown>,
        actor: JSON.parse(row.actor) as Record<string, unknown>,
      }));
    }

    function authRequest(path: string, body: unknown, cookie?: string) {
      return new Request(`https://gateway.example.com/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://gateway.example.com",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    }

    async function signIn(email: string, password: string): Promise<string> {
      const response = await createAuth().handler(
        authRequest("/sign-in/email", { email, password }),
      );
      expect(response.status).toBe(200);
      return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    }

    const nameOf = async (userId: string) =>
      (await db.select().from(users).where(eq(users.id, userId)))[0]!.name;

    /** A gateway claimed by its owner, as the real setup does: nobody owns it yet. */
    async function claimOwner() {
      await db.delete(members);
      await db.insert(ownerSetupTokens).values({
        id: "link-1",
        kind: "claim",
        tokenHash: createHash("sha256").update("est_setup").digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const claimed = await SetupService.claimOwner({
        token: "est_setup",
        name: "Owner",
        email: "owner@example.com",
        password: "owner-password-1",
      });
      clearOrgContextCacheForTests();
      return {
        ...claimed,
        ctx: {
          orgId: claimed.organizationId,
          userId: claimed.userId,
          role: "owner" as const,
        },
        cookie: await signIn("owner@example.com", "owner-password-1"),
      };
    }

    it("member.joined via setup when the owner claims the gateway, then member.invited, then member.joined via invitation when the link is accepted", async () => {
      const own = await claimOwner();
      expect(await typesEmitted(own.organizationId)).toEqual([
        expect.objectContaining({
          type: "member.joined",
          data: expect.objectContaining({
            user: expect.objectContaining({ email: "owner@example.com" }),
            role: "owner",
            via: "setup",
          }),
        }),
      ]);

      const invited = await InvitationService.invite(
        own.ctx,
        new Headers({ cookie: own.cookie }),
        { email: "jo@example.com", role: "member" },
      );
      const emitted = await typesEmitted(own.organizationId);
      expect(emitted.map((e) => e.type)).toEqual([
        "member.joined",
        "member.invited",
      ]);
      expect(emitted[1]).toMatchObject({
        data: {
          invitation: {
            id: invited.invitationId,
            email: "jo@example.com",
            role: "member",
          },
          emailSent: false,
        },
        actor: { kind: "user", id: own.userId, email: "owner@example.com" },
      });
      // Never the link (events.no-secrets-no-tool-io).
      expect(JSON.stringify(emitted[1])).not.toContain(
        new URL(invited.inviteUrl).searchParams.get("token"),
      );

      const token = new URL(invited.inviteUrl).searchParams.get("token")!;
      const signedUp = await createAuth().handler(
        authRequest(
          `/sign-up/email?invitationToken=${encodeURIComponent(token)}`,
          {
            name: "Jo",
            email: "jo@example.com",
            password: "invitee-password-1",
          },
        ),
      );
      expect(signedUp.status).toBe(200);
      const cookie = await signIn("jo@example.com", "invitee-password-1");
      const [jo] = await db
        .select()
        .from(users)
        .where(eq(users.email, "jo@example.com"));
      await InvitationService.accept(
        { id: jo!.id, email: "jo@example.com" },
        new Headers({ cookie }),
        token,
      );
      const after = await typesEmitted(own.organizationId);
      expect(after.map((e) => e.type)).toEqual([
        "member.joined",
        "member.invited",
        "member.joined",
      ]);
      expect(after[2]).toMatchObject({
        data: {
          user: { id: jo!.id, email: "jo@example.com", name: "Jo" },
          role: "member",
          via: "invitation",
        },
      });
    });

    it("member.invited from an invitation made without a session (the CLI and MCP path), never the link", async () => {
      const invited = await InvitationService.inviteWithoutSession(asOwner(), {
        email: "dee@acme.example",
        role: "admin",
      });
      const emitted = await typesEmitted();
      expect(emitted).toEqual([
        expect.objectContaining({
          type: "member.invited",
          data: {
            invitation: {
              id: invited.invitationId,
              email: "dee@acme.example",
              role: "admin",
              expiresAt: invited.expiresAt.toISOString(),
            },
            emailSent: false,
          },
          actor: expect.objectContaining({ kind: "user", id: owner }),
        }),
      ]);
      expect(JSON.stringify(emitted)).not.toContain("token=");
    });

    it("a subject lookup that fails never breaks the action: the member is deactivated and the emit is logged as failed", async () => {
      vi.spyOn(subjects, "userSubject").mockRejectedValue(
        new Error("D1_ERROR: Network connection lost."),
      );
      await expect(
        MembershipService.deactivate(asOwner(), member),
      ).resolves.toBeDefined();
      const [row] = await db.select().from(users).where(eq(users.id, member));
      expect(row!.banned).toBe(true);
      expect(await typesEmitted()).toEqual([]);
      const logged = vi
        .mocked(console.error)
        .mock.calls.map((call) => String(call[0]))
        .filter((line) => line.includes('"evt":"events.emit_failed"'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("Network connection lost");
      expect(logged[0]).toContain('"type":"unbuilt"');
    });

    it("member.deactivated, member.reactivated, member.role_changed and member.removed from the member services", async () => {
      // Read before the account goes with the removal.
      const cy = {
        id: member,
        email: "cy@acme.example",
        name: await nameOf(member),
      };
      await MembershipService.deactivate(asOwner(), member);
      await MembershipService.reactivate(asOwner(), member);
      await MembershipService.changeRole(asOwner(), member, "admin");
      await AdminService.deleteUser(asOwner(), member);
      const emitted = await typesEmitted();
      expect(emitted.map((e) => e.type)).toEqual([
        "member.deactivated",
        "member.reactivated",
        "member.role_changed",
        "member.removed",
      ]);
      expect(emitted[0]!.data).toEqual({ user: cy });
      expect(emitted[2]!.data).toMatchObject({
        role: "admin",
        previousRole: "member",
      });
      expect(emitted[3]!.data).toEqual({ user: cy, accountDeleted: true });
      for (const event of emitted) {
        expect(event.actor).toMatchObject({
          kind: "user",
          id: owner,
          email: "ada@acme.example",
        });
      }
    });

    it("tool.blocked and tool.error from a tool call's audit, never an allowed ok call, never the arguments", async () => {
      const base = {
        surface: "gateway" as const,
        tool: "crm_delete_contact",
        appId: "crm",
        risk: "destructive" as const,
        durationMs: 3,
        callId: "call-1",
        argsDigest: "digest",
        userId: member,
        organizationId: acme,
        credentialKind: "oauth" as const,
        credentialId: "conn-1",
        clientName: "Claude",
      };
      await announceToolCall({
        ...base,
        decision: "blocked",
        reason: "destructive",
        outcome: "not_run",
      });
      await announceToolCall({
        ...base,
        decision: "allowed",
        outcome: "ok",
        tool: "crm_list_contacts",
      });
      await announceToolCall({
        ...base,
        decision: "allowed",
        outcome: "app_error",
        tool: "crm_list_contacts",
        callId: "call-2",
      });
      const emitted = await typesEmitted();
      expect(emitted.map((e) => e.type)).toEqual([
        "tool.blocked",
        "tool.error",
      ]);
      expect(emitted[0]!.data).toEqual({
        tool: "crm_delete_contact",
        user: {
          id: member,
          email: "cy@acme.example",
          name: await nameOf(member),
        },
        client: { kind: "oauth", name: "Claude", id: "conn-1" },
        risk: "destructive",
        reason: "destructive",
        callId: "call-1",
      });
      expect(emitted[1]!.data).toMatchObject({
        outcome: "app_error",
        durationMs: 3,
        callId: "call-2",
      });
      expect(JSON.stringify(emitted)).not.toContain("digest");
      expect(emitted[0]!.actor).toEqual({
        kind: "agent",
        id: "conn-1",
        name: "Claude",
      });
    });

    it("cap.raised and the Cap alerts row with the first cap; cap.warning at 80%; cap.reached and app.paused_cap at the cap, each once", async () => {
      clearAppCapCache();
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "crm",
        name: "CRM",
      });
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 10,
      });
      const { subscriptions } = await EventSubscriptionService.list(asOwner());
      expect(subscriptions).toEqual([
        expect.objectContaining({
          builtin: "cap_alerts",
          sink: "email",
          recipients: "admins",
        }),
      ]);
      // A second cap doesn't make a second row; a lower cap is cap.changed, no raise.
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 8,
      });
      expect(
        (await EventSubscriptionService.list(asOwner())).subscriptions,
      ).toHaveLength(1);
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 10,
      });
      expect(
        (await typesEmitted()).map((e) => ({
          type: e.type,
          cap: e.data.cap,
          previousCap: e.data.previousCap,
        })),
      ).toEqual([
        { type: "cap.raised", cap: 10, previousCap: null },
        { type: "cap.changed", cap: 8, previousCap: 10 },
        { type: "cap.raised", cap: 10, previousCap: 8 },
      ]);

      const standing = (calls: number): MonthlyCapCheck => {
        const caps = [
          {
            kind: "calls" as const,
            cap: 10,
            used: calls,
            source: "app" as const,
          },
        ];
        const month = { month: "2026-10", calls, costMicros: 0, caps };
        return calls >= 10
          ? {
              exceeded: true,
              ...month,
              reached: caps[0]!,
              retryAfterSeconds: 1,
            }
          : { exceeded: false, ...month };
      };
      // Once a key was emitted from this isolate, the next standing with
      // the same key costs no D1 work: three batches for five checks.
      const batches = vi.spyOn(EventRepository, "insertWithDeliveries");
      await noteCapCheck(acme, app.id, standing(7));
      await noteCapCheck(acme, app.id, standing(8));
      await noteCapCheck(acme, app.id, standing(9));
      await noteCapCheck(acme, app.id, standing(10));
      await noteCapCheck(acme, app.id, standing(11));
      expect(batches).toHaveBeenCalledTimes(3);
      // The memory is per isolate and short: a fresh one re-emits, and the
      // dedupe key still drops the duplicate.
      clearCapEventMemoryForTests();
      await noteCapCheck(acme, app.id, standing(12));
      expect(batches).toHaveBeenCalledTimes(5);
      const emitted = (await typesEmitted()).filter(
        (e) => e.type !== "cap.raised" && e.type !== "cap.changed",
      );
      expect(emitted.map((e) => e.type)).toEqual([
        "cap.warning",
        "cap.reached",
        "app.paused_cap",
      ]);
      expect(emitted[0]!.data).toEqual({
        app: { id: "crm", rowId: app.id, name: "CRM" },
        kind: "calls",
        cap: 10,

        calls: 8,
        month: "2026-10",
        threshold: 80,
        source: "app",
      });
      expect(emitted[2]!.data).toMatchObject({ calls: 10 });
      // The email sink mailed the owners and admins for the two it subscribes to.
      await settleBackground();
      expect(sendMock.mock.calls.map((call) => call[0].subject).sort()).toEqual(
        [
          "[acme] CRM is at 80% of its monthly cap (8 of 10)",
          "[acme] CRM is at 80% of its monthly cap (8 of 10)",
          "[acme] CRM reached its monthly cap (10)",
          "[acme] CRM reached its monthly cap (10)",
        ],
      );
      // Removing the cap: raised to none.
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: null,
      });
      expect((await typesEmitted()).at(-1)).toMatchObject({
        type: "cap.raised",
        data: { cap: null, previousCap: 10 },
      });
    });

    it("the dollar cap: cap.warning, cap.reached and app.paused_cap by kind with dollars, and cap.raised with costCap", async () => {
      clearAppCapCache();
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "crm",
        name: "CRM",
      });
      // A dollar cap alone keeps no call cap, and is announced in dollars.
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        costUsd: 20,
      });
      // The call cap set beside it keeps the dollar cap: no costCap fields.
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 100,
      });
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        costUsd: 25.5,
      });
      expect(
        (await typesEmitted()).map((e) => ({ type: e.type, data: e.data })),
      ).toEqual([
        {
          type: "cap.raised",
          data: {
            app: { id: "crm", rowId: app.id, name: "CRM" },
            cap: null,
            previousCap: null,
            costCap: 20,
            previousCostCap: null,
            source: "app",
          },
        },
        {
          type: "cap.raised",
          data: {
            app: { id: "crm", rowId: app.id, name: "CRM" },
            cap: 100,
            previousCap: null,
            source: "app",
          },
        },
        {
          type: "cap.raised",
          data: {
            app: { id: "crm", rowId: app.id, name: "CRM" },
            cap: 100,
            previousCap: 100,
            costCap: 25.5,
            previousCostCap: 20,
            source: "app",
          },
        },
      ]);

      // Calls at half their cap, dollars at 80% then at the cap: the
      // dollar cap's events alone, each once.
      const costCap = 25_500_000;
      const standing = (costMicros: number): MonthlyCapCheck => {
        const caps = [
          {
            kind: "calls" as const,
            cap: 100,
            used: 50,
            source: "app" as const,
          },
          {
            kind: "cost" as const,
            cap: costCap,
            used: costMicros,
            source: "app" as const,
          },
        ];
        const month = { month: "2026-10", calls: 50, costMicros, caps };
        return costMicros >= costCap
          ? {
              exceeded: true,
              ...month,
              reached: caps[1]!,
              retryAfterSeconds: 1,
            }
          : { exceeded: false, ...month };
      };
      await noteCapCheck(acme, app.id, standing(20_400_000));
      await noteCapCheck(acme, app.id, standing(26_000_000));
      clearCapEventMemoryForTests();
      await noteCapCheck(acme, app.id, standing(27_000_000));
      const emitted = (await typesEmitted()).filter(
        (e) => e.type !== "cap.raised",
      );
      expect(emitted.map((e) => [e.type, e.data.kind])).toEqual([
        ["cap.warning", "cost"],
        ["cap.reached", "cost"],
        ["app.paused_cap", "cost"],
      ]);
      expect(emitted[0]!.data).toEqual({
        app: { id: "crm", rowId: app.id, name: "CRM" },
        kind: "cost",
        costCap: 25.5,
        cost: 20.4,
        calls: 50,
        month: "2026-10",
        threshold: 80,
        source: "app",
      });
      await settleBackground();
      expect(sendMock.mock.calls.map((call) => call[0].subject).sort()).toEqual(
        [
          "[acme] CRM is at 80% of its monthly dollar cap ($20.40 of $25.50)",
          "[acme] CRM is at 80% of its monthly dollar cap ($20.40 of $25.50)",
          "[acme] CRM reached its monthly dollar cap ($25.50)",
          "[acme] CRM reached its monthly dollar cap ($25.50)",
        ],
      );
    });

    it("cap.raised with source default and no app, and the Cap alerts row, from the workspace default too", async () => {
      clearAppCapCache();
      await AppCapService.setDefaultMonthlyCap(asOwner(), { cap: 100 });
      expect(
        (await EventSubscriptionService.list(asOwner())).subscriptions,
      ).toEqual([
        expect.objectContaining({
          builtin: "cap_alerts",
          sink: "email",
          recipients: "admins",
        }),
      ]);
      // A lower default is cap.changed and no second row; a higher one and a
      // removal are cap.raised, without an app.
      await AppCapService.setDefaultMonthlyCap(asOwner(), { cap: 50 });
      await AppCapService.setDefaultMonthlyCap(asOwner(), { cap: 200 });
      await AppCapService.setDefaultMonthlyCap(asOwner(), { cap: null });
      expect(
        (await typesEmitted()).map((e) => ({ type: e.type, data: e.data })),
      ).toEqual([
        {
          type: "cap.raised",
          data: { app: null, cap: 100, previousCap: null, source: "default" },
        },
        {
          type: "cap.changed",
          data: { app: null, cap: 50, previousCap: 100, source: "default" },
        },
        {
          type: "cap.raised",
          data: { app: null, cap: 200, previousCap: 50, source: "default" },
        },
        {
          type: "cap.raised",
          data: { app: null, cap: null, previousCap: 200, source: "default" },
        },
      ]);
      expect(
        (await EventSubscriptionService.list(asOwner())).subscriptions,
      ).toHaveLength(1);
    });

    it("cap.raised measures the cap that binds the app: a cap under the default is no raise, back to the default is one, unlimited under a default is a removal", async () => {
      clearAppCapCache();
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "crm",
        name: "CRM",
      });
      const crm = { id: "crm", rowId: app.id, name: "CRM" };
      await AppCapService.setDefaultMonthlyCap(asOwner(), { cap: 1_000 });
      // Tighter than the default: no raise, but cap.changed says so.
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 500,
      });
      // The row goes and the default binds again: a raise to the default.
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: null,
      });
      // No cap whatever the default: a removal, said once.
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: null,
        unlimited: true,
      });
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: null,
        unlimited: true,
      });
      // A cap where there was none: set.
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 5_000,
      });
      expect(
        (await typesEmitted()).map((e) => ({ type: e.type, data: e.data })),
      ).toEqual([
        {
          type: "cap.raised",
          data: { app: null, cap: 1_000, previousCap: null, source: "default" },
        },
        {
          type: "cap.changed",
          data: { app: crm, cap: 500, previousCap: 1_000, source: "app" },
        },
        {
          type: "cap.raised",
          data: { app: crm, cap: 1_000, previousCap: 500, source: "app" },
        },
        {
          type: "cap.raised",
          data: { app: crm, cap: null, previousCap: 1_000, source: "app" },
        },
        {
          type: "cap.raised",
          data: { app: crm, cap: 5_000, previousCap: null, source: "app" },
        },
      ]);
    });

    it("token.created and token.revoked name the token's row and never its value", async () => {
      const created = await UserPatService.create({
        userId: owner,
        organizationId: acme,
        name: "ci-deploy",
        scopes: ["mcp:read"],
      });
      await UserPatService.revoke(created.row.id, owner);
      const emitted = await typesEmitted();
      expect(emitted.map((e) => e.type)).toEqual([
        "token.created",
        "token.revoked",
      ]);
      expect(emitted[0]!.data).toMatchObject({
        id: created.row.id,
        name: "ci-deploy",
        scopes: ["mcp:read"],
        user: { id: owner, email: "ada@acme.example" },
      });
      expect(emitted[1]!.data).toMatchObject({
        id: created.row.id,
        name: "ci-deploy",
      });
      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain(created.plaintext);
      expect(serialized).not.toContain(created.plaintext.slice(5, 20));
    });

    it("connection.revoked when a person revokes an AI app, with the reason", async () => {
      await McpConnectionRepository.create({
        id: "mcpc_1",
        userId: owner,
        organizationId: acme,
        clientId: "https://claude.ai/oauth/claude-code-client-metadata",
        clientName: "Claude Code",
        clientDomain: "claude.ai",
        redirectUri: "http://localhost:1/callback",
        redirectHost: "localhost",
        appScope: "all",
        appRowIds: [],
        access: "write",
        createdAt: clock,
      });
      await McpConnectionService.revokeForUser(owner, "mcpc_1");
      const emitted = await typesEmitted();
      expect(emitted).toEqual([
        expect.objectContaining({
          type: "connection.revoked",
          data: {
            connection: { id: "mcpc_1", clientName: "Claude Code" },
            user: {
              id: owner,
              email: "ada@acme.example",
              name: await nameOf(owner),
            },
            reason: "user",
          },
          actor: expect.objectContaining({ kind: "user", id: owner }),
        }),
      ]);
      // Revoking what is already revoked says nothing more.
      await McpConnectionService.revokeForDeactivatedUser(owner);
      expect(await typesEmitted()).toHaveLength(1);
    });

    it("app.needs_setup on the first evaluation that finds a setting missing, app.ready once it is set, and nothing in between", async () => {
      resetAppSetupCacheForTests();
      clearSetupStateMemoryForTests();
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "crm",
        name: "CRM",
        manifest: { id: "crm", secrets: ["MAIN_SECRET"] },
      });
      const row = () => ({
        id: app.id,
        organizationId: acme,
        appId: "crm",
        name: "CRM",
        tier: "service_binding",
        versionId: "v1",
        manifest: JSON.stringify({ id: "crm", secrets: ["MAIN_SECRET"] }),
        secretNames: "[]",
      });
      await listedAppSetup(row(), true);
      await settleBackground();
      await listedAppSetup(row(), true);
      await settleBackground();
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "app.needs_setup",
          data: {
            app: { id: "crm", rowId: app.id, name: "CRM" },
            unmet: ["MAIN_SECRET"],
          },
        }),
      ]);
      expect(
        (
          await db
            .select({ s: apps.setupState })
            .from(apps)
            .where(eq(apps.id, app.id))
        )[0]!.s,
      ).toBe("needs_setup");

      clearSetupStateMemoryForTests();
      await listedAppSetup(
        { ...row(), secretNames: JSON.stringify(["MAIN_SECRET"]) },
        true,
      );
      await settleBackground();
      expect((await typesEmitted()).map((e) => e.type)).toEqual([
        "app.needs_setup",
        "app.ready",
      ]);
      expect(
        (
          await db
            .select({ s: apps.setupState })
            .from(apps)
            .where(eq(apps.id, app.id))
        )[0]!.s,
      ).toBe("ready");
    });

    it("a first evaluation that finds an app ready emits nothing", async () => {
      resetAppSetupCacheForTests();
      clearSetupStateMemoryForTests();
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "notes",
        name: "Notes",
        manifest: { id: "notes", secrets: ["KEY"] },
      });
      await listedAppSetup(
        {
          id: app.id,
          organizationId: acme,
          appId: "notes",
          name: "Notes",
          tier: "service_binding",
          versionId: "v1",
          manifest: JSON.stringify({ id: "notes", secrets: ["KEY"] }),
          secretNames: JSON.stringify(["KEY"]),
        },
        true,
      );
      await settleBackground();
      expect(await typesEmitted()).toEqual([]);
      expect(
        (
          await db
            .select({ s: apps.setupState })
            .from(apps)
            .where(eq(apps.id, app.id))
        )[0]!.s,
      ).toBe("ready");
    });

    it("app.tools_changed when the stored tool names differ, with the kind, and nothing when they don't", async () => {
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "crm",
        name: "CRM",
      });
      const route = {
        rowId: app.id,
        organizationId: acme,
        tier: "service_binding",
      };
      await announceToolsChanged({
        app: route,
        previous: ["a", "b"],
        current: ["b", "a"],
      });
      await announceToolsChanged({
        app: route,
        previous: ["a", "b"],
        current: ["a", "c", "d"],
      });
      await announceToolsChanged({
        app: { ...route, tier: "provider" },
        previous: [],
        current: ["x"],
      });
      const emitted = await typesEmitted();
      expect(emitted.map((e) => e.type)).toEqual([
        "app.tools_changed",
        "app.tools_changed",
      ]);
      expect(emitted[0]!.data).toEqual({
        app: { id: "crm", rowId: app.id, name: "CRM" },
        kind: "app",
        toolCount: 3,
        previousToolCount: 2,
        added: ["c", "d"],
        removed: ["b"],
      });
      expect(emitted[1]!.data).toMatchObject({
        kind: "builtin",
        toolCount: 1,
        previousToolCount: 0,
      });
    });

    it("member.joined via access: a pending invitation accepted by the Access sign-in, and an auto-join domain", async () => {
      const config = {
        oidc: null,
        outerRing: null,
        autoJoinDomains: ["acme.example"],
        passwordSignIn: true,
        problems: [],
      };
      await db.insert(users).values([
        {
          id: "u-invited",
          name: "Eve",
          email: "eve@elsewhere.example",
          emailVerified: true,
        },
        {
          id: "u-domain",
          name: "Fay",
          email: "fay@acme.example",
          emailVerified: true,
        },
      ]);
      await db.insert(invitations).values({
        id: "inv-eve",
        organizationId: acme,
        email: "eve@elsewhere.example",
        role: "admin",
        status: "pending",
        expiresAt: new Date(clock.getTime() + 60_000),
        inviterId: owner,
      });
      await ensureAccessMembership("u-invited", "outer-ring", config);
      await ensureAccessMembership("u-domain", "outer-ring", config);
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "member.joined",
          data: {
            user: {
              id: "u-invited",
              email: "eve@elsewhere.example",
              name: "Eve",
            },
            role: "admin",
            via: "access",
          },
          actor: expect.objectContaining({ kind: "user", id: "u-invited" }),
        }),
        expect.objectContaining({
          type: "member.joined",
          data: {
            user: { id: "u-domain", email: "fay@acme.example", name: "Fay" },
            role: "member",
            via: "access",
          },
        }),
      ]);
      // Signing in again joins nothing twice.
      await ensureAccessMembership("u-domain", "outer-ring", config);
      expect(await typesEmitted()).toHaveLength(2);
    });

    it("member.joined via member_add when a member is added server-side, by the gateway", async () => {
      await db.insert(users).values({
        id: "u-added",
        name: "Gus",
        email: "gus@acme.example",
        emailVerified: true,
      });
      await createAuth().api.addMember({
        body: { userId: "u-added", organizationId: acme, role: "member" },
      });
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "member.joined",
          data: {
            user: { id: "u-added", email: "gus@acme.example", name: "Gus" },
            role: "member",
            via: "member_add",
          },
          actor: { kind: "gateway" },
        }),
      ]);
    });

    it("member.deactivated with reason deleted_with_access_auto_join when a delete would let Access straight back in", async () => {
      workerEnv["CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS"] = "acme.example";
      try {
        await expect(
          AdminService.deleteUser(asOwner(), member),
        ).resolves.toEqual({ deactivatedInstead: true });
      } finally {
        delete workerEnv["CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS"];
      }
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "member.deactivated",
          data: {
            user: {
              id: member,
              email: "cy@acme.example",
              name: await nameOf(member),
            },
            reason: "deleted_with_access_auto_join",
          },
          actor: expect.objectContaining({ kind: "user", id: owner }),
        }),
      ]);
    });

    it("member.password_reset when a reset completes, saying an admin's link started it", async () => {
      const link = await MembershipService.createPasswordResetLink(
        asOwner(),
        member,
      );
      expect(await typesEmitted()).toEqual([]);
      const token = new URL(link.url).searchParams.get("token")!;
      await createAuth().api.resetPassword({
        body: { newPassword: "a-new-password-123", token },
      });
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "member.password_reset",
          data: {
            user: {
              id: member,
              email: "cy@acme.example",
              name: await nameOf(member),
            },
            by: "admin_link",
          },
          actor: { kind: "gateway" },
        }),
      ]);
      expect(JSON.stringify(await typesEmitted())).not.toContain(token);
    });

    it("connection.created once a consent wrote the row, with the grant and never a token", async () => {
      await McpConnectionService.announceCreated({
        id: "mcpc_new",
        userId: owner,
        organizationId: acme,
        clientName: "Claude",
        clientDomain: "claude.ai",
        access: "write",
        appScope: "selected",
      });
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "connection.created",
          data: {
            connection: {
              id: "mcpc_new",
              clientName: "Claude",
              clientDomain: "claude.ai",
              access: "write",
              appScope: "selected",
            },
            user: {
              id: owner,
              email: "ada@acme.example",
              name: await nameOf(owner),
            },
          },
          actor: expect.objectContaining({ kind: "user", id: owner }),
        }),
      ]);
    });

    it("connection.revoked for every reason: ended, expired, superseded and member_removed", async () => {
      const connection = (id: string, userId: string, createdAt: Date) => ({
        id,
        userId,
        organizationId: acme,
        clientId: "https://claude.ai/oauth/claude-code-client-metadata",
        clientName: "Claude Code",
        clientDomain: "claude.ai",
        redirectUri: "http://localhost:1/callback",
        redirectHost: "localhost",
        appScope: "all" as const,
        appRowIds: [],
        access: "write" as const,
        createdAt,
      });
      const old = new Date(clock.getTime() - 40 * 24 * 60 * 60 * 1000);
      await McpConnectionRepository.create(connection("c-ended", owner, clock));
      await McpConnectionRepository.create(connection("c-idle", admin, old));
      await McpConnectionRepository.create(connection("c-early", owner, old));
      await McpConnectionRepository.create(connection("c-late", owner, clock));
      await McpConnectionRepository.create(connection("c-cy", member, clock));

      await McpConnectionService.revokeConnection("c-ended", "ended");
      expect(
        await McpConnectionService.expireIdle(
          new Date(clock.getTime() - 31 * 24 * 60 * 60 * 1000),
        ),
      ).toBe(2);
      await McpConnectionService.supersedeEarlier({
        ...connection("c-late", owner, clock),
      });
      await McpConnectionService.revokeForRemovedMember(member, acme);
      const emitted = await typesEmitted();
      expect(
        emitted.map((e) => [
          e.type,
          (e.data["connection"] as { id: string }).id,
          e.data["reason"],
          e.actor["kind"],
        ]),
      ).toEqual([
        ["connection.revoked", "c-ended", "ended", "gateway"],
        ["connection.revoked", "c-idle", "expired", "gateway"],
        ["connection.revoked", "c-early", "expired", "gateway"],
        ["connection.revoked", "c-cy", "member_removed", "gateway"],
      ]);
    });

    it("app.needs_setup from the perimeter's setup gate, once per isolate for the row", async () => {
      resetAppSetupCacheForTests();
      resetNeedsSetupLogForTests();
      clearSetupStateMemoryForTests();
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "crm",
        name: "CRM",
        manifest: { id: "crm", secrets: ["MAIN_SECRET"] },
      });
      const gate = () =>
        refuseUnreadyApp({
          app: {
            appId: "crm",
            rowId: app.id,
            hostname: "crm.gateway.example.com",
            workerName: "every-crm",
            tier: "service_binding",
            scope: "org",
            organizationId: acme,
            status: "active",
            // The gate names the app from its manifest (the perimeter's
            // RegisteredApp carries no row name).
            manifest: validateManifest({
              id: "crm",
              name: "CRM",
              secrets: ["MAIN_SECRET"],
            }),
            versionId: "v1",
            secretNames: [],
          },
          request: new Request("https://crm.gateway.example.com/api/todos"),
          publicRoute: false,
        });
      expect((await gate())?.status).toBe(503);
      await settleBackground();
      expect((await gate())?.status).toBe(503);
      await settleBackground();
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "app.needs_setup",
          data: {
            app: { id: "crm", rowId: app.id, name: "CRM" },
            unmet: ["MAIN_SECRET"],
          },
          actor: { kind: "gateway" },
        }),
      ]);
    });

    it("mcp_app.removed when an admin removes an MCP app's row", async () => {
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "dataforseo",
        name: "DataForSEO",
      });
      await db
        .update(apps)
        .set({ tier: PROVIDER_APP_TIER })
        .where(eq(apps.id, app.id));
      await AppService.delete(asOwner(), app.id);
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "mcp_app.removed",
          data: {
            app: { id: "dataforseo", rowId: app.id, name: "DataForSEO" },
            kind: "builtin",
          },
        }),
      ]);
    });

    it("app.removed when an admin removes an app, as a tombstone", async () => {
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug: "crm",
        name: "CRM",
      });
      await AppService.delete(asOwner(), app.id);
      expect(await typesEmitted()).toEqual([
        expect.objectContaining({
          type: "app.removed",
          data: {
            app: { id: "crm", rowId: app.id, name: "CRM" },
            purged: false,
          },
        }),
      ]);
    });
  });
  describe("admin emit points (audit coverage: each admin write is one event with its actor)", () => {
    async function emitted(organizationId = acme) {
      const rows = await db
        .select({ type: events.type, data: events.data, actor: events.actor })
        .from(events)
        .where(eq(events.organizationId, organizationId));
      return rows.map((row) => ({
        type: row.type,
        data: JSON.parse(row.data) as Record<string, unknown>,
        actor: JSON.parse(row.actor) as Record<string, unknown>,
      }));
    }
    const adaActor = () =>
      expect.objectContaining({
        kind: "user",
        id: owner,
        email: "ada@acme.example",
      });

    async function anApp(appSlug = "crm") {
      const { app } = await registerApp(db, {
        organizationId: acme,
        appSlug,
        name: appSlug.toUpperCase(),
      });
      await settleBackground();
      await db.delete(events);
      return app;
    }

    it("organization.renamed when the workspace is renamed, with the previous name", async () => {
      await OrganizationService.rename(asOwner(), "Acme Corp");
      expect(await emitted()).toEqual([
        expect.objectContaining({
          type: "organization.renamed",
          data: { name: "Acme Corp", previousName: "acme" },
          actor: adaActor(),
        }),
      ]);
      // The same name again is no event.
      await OrganizationService.rename(asOwner(), "Acme Corp");
      expect((await emitted()).length).toBe(1);
    });

    it("member.invitation_cancelled from the session-less cancel (the MCP tool's path); never the link", async () => {
      await db.insert(invitations).values({
        id: "inv-1",
        organizationId: acme,
        email: "jo@acme.example",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: owner,
      });
      await AdminService.cancelInvitationWithoutSession(asOwner(), "inv-1");
      const [event] = await emitted();
      expect(event).toMatchObject({
        type: "member.invitation_cancelled",
        data: {
          invitation: { id: "inv-1", email: "jo@acme.example", role: "member" },
        },
        actor: adaActor(),
      });
      expect(JSON.stringify(event!.data)).not.toMatch(/token|link/i);
    });

    it("group.created, group.updated, group.members_changed, group.apps_changed and group.removed, each once, with the members and apps named", async () => {
      const app = await anApp();
      const group = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      await GroupService.updateGroup(asOwner(), group.id, {
        name: "Sales EMEA",
      });
      await GroupService.setGroupMembers(asOwner(), group.id, [member]);
      await GroupService.setGroupApps(asOwner(), group.id, [app.id]);
      await GroupService.setGroupApps(asOwner(), group.id, [app.id]); // unchanged: no event
      await GroupService.deleteGroup(asOwner(), group.id);
      const all = await emitted();
      expect(all.map((e) => e.type)).toEqual([
        "group.created",
        "group.updated",
        "group.members_changed",
        "group.apps_changed",
        "group.removed",
      ]);
      expect(all[0]).toMatchObject({
        data: { group: { id: group.id, name: "Sales" } },
        actor: adaActor(),
      });
      expect(all[1]!.data).toEqual({
        group: { id: group.id, name: "Sales EMEA" },
        previousName: "Sales",
      });
      expect(all[2]!.data).toMatchObject({
        added: [{ id: member, email: "cy@acme.example" }],
        removed: [],
        addedCount: 1,
        removedCount: 0,
      });
      expect(all[3]!.data).toMatchObject({
        granted: [{ id: "crm", rowId: app.id, name: "CRM" }],
        grantedCount: 1,
        revokedCount: 0,
      });
      expect(all[4]!.data).toEqual({
        group: { id: group.id, name: "Sales EMEA" },
      });
    });

    it("app.access_changed with who was granted and revoked, and app.renamed; 'available to everyone' names everyone it granted", async () => {
      const app = await anApp();
      await AppAccessService.updateAccessForApp(asOwner(), app.id, [member]);
      await AppAccessService.updateAccessForApp(asOwner(), app.id, [member]); // unchanged
      await AppAccessService.updateAccessForApp(asOwner(), app.id, []);
      await AppService.update(asOwner(), { id: app.id, name: "Contacts" });
      await AppService.update(asOwner(), { id: app.id, isDefault: true });
      const all = await emitted();
      expect(all.map((e) => e.type)).toEqual([
        "app.access_changed",
        "app.access_changed",
        "app.renamed",
        "app.access_changed",
      ]);
      // registerApp granted the admin: setting the list to Cy alone revokes Bo.
      expect(all[0]!.data).toMatchObject({
        app: { id: "crm", rowId: app.id },
        granted: [{ id: member, email: "cy@acme.example" }],
        revoked: [{ email: "bo@acme.example" }],
        grantedCount: 1,
        revokedCount: 1,
      });
      expect(all[1]!.data).toMatchObject({
        granted: [],
        revoked: [{ id: member }],
      });
      expect(all[2]!.data).toEqual({
        app: { id: "crm", rowId: app.id, name: "Contacts" },
        previousName: "CRM",
      });
      expect(all[3]!.data).toMatchObject({ everyone: true, grantedCount: 3 });
      expect(all[3]!.actor).toEqual(adaActor());
    });

    it("cap.changed when a cap is set under the default or lowered (cap.raised stays for a raise); the default cap likewise", async () => {
      const app = await anApp();
      await AppCapService.setDefaultMonthlyCap(asOwner(), { cap: 1000 }); // cap.raised
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 500,
      }); // under the default: changed
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 2000,
      }); // raised
      await AppCapService.setMonthlyCap(asOwner(), {
        appRowId: app.id,
        cap: 1500,
      }); // lowered
      await AppCapService.setDefaultMonthlyCap(asOwner(), { cap: 800 }); // lowered default
      const all = await emitted();
      expect(all.map((e) => e.type)).toEqual([
        "cap.raised",
        "cap.changed",
        "cap.raised",
        "cap.changed",
        "cap.changed",
      ]);
      expect(all[1]!.data).toEqual({
        app: { id: "crm", rowId: app.id, name: "CRM" },
        cap: 500,
        previousCap: 1000,
        source: "app",
      });
      expect(all[3]!.data).toMatchObject({ cap: 1500, previousCap: 2000 });
      expect(all[4]!.data).toEqual({
        app: null,
        cap: 800,
        previousCap: 1000,
        source: "default",
      });
    });

    it("subscription.created, subscription.updated, subscription.redelivered and subscription.removed, never the secret or the URL", async () => {
      fetchMock.mockResolvedValue(new Response("no", { status: 500 }));
      // The service itself, not addWebhook: its housekeeping is the subject here.
      const { subscription, secret } = await EventSubscriptionService.add(
        asOwner(),
        {
          url: "https://hooks.example.net/every-app?key=querysecret",
          events: ["member.*", "subscription.*"],
          name: "Slack",
        },
      );
      await settleBackground();
      await EventSubscriptionService.update(asOwner(), subscription.id, {
        enabled: false,
      });
      await EventSubscriptionService.update(asOwner(), subscription.id, {
        enabled: false,
      }); // unchanged
      await settleBackground();
      const deliveries = await EventSubscriptionService.deliveries(
        asOwner(),
        {},
      );
      const failed = deliveries.deliveries[0]!;
      await EventSubscriptionService.redeliver(asOwner(), failed.id);
      await settleBackground();
      await EventSubscriptionService.remove(asOwner(), subscription.id);
      const all = await emitted();
      expect(all.map((e) => e.type)).toEqual([
        "subscription.created",
        "subscription.updated",
        "subscription.redelivered",
        "subscription.removed",
      ]);
      expect(all[0]!.data).toEqual({
        subscription: { id: subscription.id, name: "Slack", sink: "webhook" },
        events: ["member.*", "subscription.*"],
        host: "hooks.example.net",
      });
      expect(all[1]!.data).toEqual({
        subscription: { id: subscription.id, name: "Slack", sink: "webhook" },
        changed: ["enabled"],
        enabled: false,
      });
      expect(all[2]!.data).toMatchObject({
        delivery: { id: failed.id, eventType: "subscription.created" },
      });
      expect(all[3]!.data).toEqual({
        subscription: { id: subscription.id, name: "Slack", sink: "webhook" },
        disabled: false,
      });
      const text = JSON.stringify(all.map((e) => e.data));
      expect(text).not.toContain(secret!);
      expect(text).not.toContain("querysecret");
      expect(text).not.toContain("https://");
      for (const event of all) expect(event.actor).toEqual(adaActor());
    });

    it("names the agent as the actor when a write comes through the Gateway's MCP tools: the credential, the client name and the member it acts for", async () => {
      const result = await runWorkspaceTool(
        "workspace_group_create",
        { name: "Agents" },
        {
          userId: owner,
          email: "ada@acme.example",
          organizationId: acme,
          orgRole: "owner",
          credential: { kind: "oauth", id: "conn-1", clientName: "Claude" },
          access: "write",
        },
      );
      expect(result.isError).not.toBe(true);
      const [event] = await emitted();
      expect(event).toMatchObject({
        type: "group.created",
        actor: {
          kind: "agent",
          id: "conn-1",
          name: "Claude",
          email: "ada@acme.example",
        },
      });
      expect(summarize(event!.type, event!.data, event!.actor)).toBe(
        "Claude created the group Agents",
      );
    });
  });
});
