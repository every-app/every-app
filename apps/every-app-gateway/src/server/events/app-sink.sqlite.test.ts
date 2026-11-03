/**
 * The `app` event sink against a migrated SQLite database
 * (docs/design/2026-11-birds-decisions/app-event-sink.md): a subscription
 * the deploy made from an app's manifest delivers over the app's binding
 * to `/__everyapp/events` with an `events.deliver` system token bound to
 * the body; it hears its own organization only, only the families on the
 * allowlist, never its own events back; and it retries and dead-letters
 * like a webhook.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

import { eq } from "drizzle-orm";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import {
  APP_EVENTS_PATH,
  EVENT_DELIVERY_MAX_ATTEMPTS,
  EVENT_HEADERS,
  EVENT_RETRY_DELAYS_MS,
  SYSTEM_HEADER,
  bodyHash,
  verifySystemJwt,
} from "@every-app/sdk/internal";
import { apps, eventDeliveries, eventSubscriptions } from "@/db/schema";
import { emitAndWait } from "@/server/events/bus";
import { catalogue, type EventActor } from "@/server/events/catalogue";
import {
  deliverOnce,
  setDeliveryDepsForTests,
  type DeliveryDeps,
} from "@/server/events/deliver";
import type { AppSinkTarget } from "@/server/events/app-sink";
import { EventSubscriptionService } from "@/server/events/subscriptions";
import { clearEventSubjectCachesForTests } from "@/server/events/subjects";
import { AppRepository } from "@/server/repositories/AppRepository";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const ISSUER = "https://gateway.example.com";
let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKeyPem = await exportPKCS8(keys.privateKey);
  publicKeyPem = await exportSPKI(keys.publicKey);
});

const actor: EventActor = {
  kind: "user",
  id: "user-x",
  email: "ada@acme.example",
  name: "Ada",
};

describe("the app event sink (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let globex: string;
  let owner: string;
  let clock: Date;
  const appFetch = vi.fn<(request: Request) => Promise<Response>>();
  const reached: AppSinkTarget[] = [];
  const webhookFetch = vi.fn<typeof fetch>();
  const deps: DeliveryDeps = {
    fetch: (input, init) => webhookFetch(input, init),
    mailer: async () => {
      throw new Error("no mail here");
    },
    now: () => clock,
    gatewayUrl: () => ISSUER,
    userAgent: () => "every-app-gateway/1.2.3",
    targetRules: () => ({
      allowPrivate: false,
      gatewayHosts: ["gateway.example.com"],
    }),
    appSink: () => ({
      fetcherFor: (app) => {
        reached.push(app);
        return { fetch: (request) => appFetch(request) };
      },
      signing: () => ({ privateKeyPem, issuer: ISSUER }),
    }),
  };

  function setClock(date: Date): void {
    clock = date;
    vi.setSystemTime(date);
  }

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(new Date("2026-11-01T10:00:00.000Z"));
    appFetch.mockReset().mockResolvedValue(Response.json({ ok: true }));
    webhookFetch.mockReset();
    reached.length = 0;
    setDeliveryDepsForTests(deps);
    clearEventSubjectCachesForTests();
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
    await seedMember(db, { organizationId: globex, role: "owner" });
  });

  afterEach(() => {
    setDeliveryDepsForTests(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** An app live in `organizationId`, and its sink as the deploy writes it. */
  async function appWithSink(
    organizationId: string,
    appSlug: string,
    events: string[],
  ) {
    const { app } = await deployLiveApp(db, {
      organizationId,
      appSlug,
      name: appSlug,
    });
    const id = `sub_${appSlug}${organizationId.slice(0, 8)}`.padEnd(28, "0");
    await db.insert(eventSubscriptions).values({
      id,
      organizationId,
      name: appSlug,
      sink: "app",
      appRowId: app.id,
      events: JSON.stringify(events),
      enabled: true,
      createdAt: clock,
      updatedAt: clock,
      createdBy: "operator:deployer@example.com",
    });
    return { app, subscriptionId: id };
  }

  function removed(organizationId: string) {
    return {
      organizationId,
      actor,
      ...catalogue.memberRemoved({
        user: { id: "user-cy", email: "cy@acme.example", name: "Cy" },
        accountDeleted: false,
      }),
    };
  }

  async function deliveriesOf(subscriptionId: string) {
    return db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.subscriptionId, subscriptionId));
  }

  it("delivers over the app's binding to /__everyapp/events with an events.deliver token for its Worker and this body (events.app-sink-binding)", async () => {
    const { app, subscriptionId } = await appWithSink(acme, "birds", [
      "member.*",
    ]);
    await emitAndWait(removed(acme));

    expect(webhookFetch).not.toHaveBeenCalled();
    expect(reached).toEqual([expect.objectContaining({ rowId: app.id })]);
    expect(appFetch).toHaveBeenCalledTimes(1);
    const request = appFetch.mock.calls[0]![0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`https://${app.hostname}${APP_EVENTS_PATH}`);
    expect(request.headers.get(EVENT_HEADERS.event)).toBe("member.removed");
    const body = await request.text();
    const envelope = JSON.parse(body) as {
      type: string;
      organization: { id: string };
    };
    expect(envelope).toMatchObject({
      type: "member.removed",
      organization: { id: acme },
    });
    const claims = await verifySystemJwt(request.headers.get(SYSTEM_HEADER)!, {
      publicKeys: [publicKeyPem],
      audience: app.workerName!,
      issuer: ISSUER,
      purpose: "events.deliver",
    });
    expect(claims.bh).toBe(await bodyHash(body));
    expect(await deliveriesOf(subscriptionId)).toEqual([
      expect.objectContaining({ status: "delivered", attempts: 1 }),
    ]);
  });

  it("hears its own organization only, and never reaches another organization's app (events.app-sink-org-scoped)", async () => {
    const { subscriptionId } = await appWithSink(acme, "birds", ["member.*"]);
    await emitAndWait(removed(globex));
    expect(await deliveriesOf(subscriptionId)).toHaveLength(0);
    expect(appFetch).not.toHaveBeenCalled();

    // A row edited by hand to name another organization's app delivers
    // nothing: the app is looked up under the subscription's organization.
    const { app: globexApp } = await deployLiveApp(db, {
      organizationId: globex,
      appSlug: "spy",
    });
    await db
      .update(eventSubscriptions)
      .set({ appRowId: globexApp.id })
      .where(eq(eventSubscriptions.id, subscriptionId));
    await emitAndWait(removed(acme));
    expect(appFetch).not.toHaveBeenCalled();
    expect(await deliveriesOf(subscriptionId)).toEqual([
      expect.objectContaining({ status: "dead", lastError: "app_gone" }),
    ]);
  });

  it("queues only the families on the allowlist, whatever the stored patterns say (events.app-sink-allowlist)", async () => {
    const { subscriptionId } = await appWithSink(acme, "birds", ["*"]);
    for (const type of [
      "token.created",
      "cap.reached",
      "provider.connected",
      "organization.renamed",
      "access.changed",
      "member.password_reset",
      "billing.something_new",
    ]) {
      await emitAndWait({
        organizationId: acme,
        actor,
        type,
        version: 1,
        data: {},
      });
    }
    expect(await deliveriesOf(subscriptionId)).toHaveLength(0);
    await emitAndWait(removed(acme));
    expect(await deliveriesOf(subscriptionId)).toHaveLength(1);
  });

  it("never sends an app its own events back, but does send another app's", async () => {
    const { app, subscriptionId } = await appWithSink(acme, "birds", ["app.*"]);
    const { app: crm } = await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "crm",
    });
    await emitAndWait({
      organizationId: acme,
      actor: { kind: "app", id: "birds" } as never,
      type: "app.birds.agent_started",
      version: 1,
      data: {},
      appRowId: app.id,
    });
    expect(await deliveriesOf(subscriptionId)).toHaveLength(0);
    await emitAndWait({
      organizationId: acme,
      actor: { kind: "app", id: "crm" } as never,
      type: "app.crm.contact_added",
      version: 1,
      data: {},
      appRowId: crm.id,
    });
    expect(await deliveriesOf(subscriptionId)).toHaveLength(1);
  });

  it("retries a failed delivery with the webhook backoff, then dead-letters it after the last attempt (events.app-sink-retry)", async () => {
    const { subscriptionId } = await appWithSink(acme, "birds", ["member.*"]);
    appFetch.mockImplementation(async () =>
      Response.json({ error: "handler_failed" }, { status: 500 }),
    );
    await emitAndWait(removed(acme));
    let [delivery] = await deliveriesOf(subscriptionId);
    expect(delivery).toMatchObject({
      status: "pending",
      attempts: 1,
      lastStatusCode: 500,
    });
    expect(delivery!.nextAttemptAt!.getTime() - clock.getTime()).toBe(
      EVENT_RETRY_DELAYS_MS[0],
    );
    for (
      let attempt = 2;
      attempt <= EVENT_DELIVERY_MAX_ATTEMPTS;
      attempt += 1
    ) {
      setClock(new Date(delivery!.nextAttemptAt!.getTime() + 1));
      await deliverOnce(delivery!.id);
      [delivery] = await deliveriesOf(subscriptionId);
    }
    expect(delivery).toMatchObject({
      status: "dead",
      attempts: EVENT_DELIVERY_MAX_ATTEMPTS,
    });
    expect(appFetch).toHaveBeenCalledTimes(EVENT_DELIVERY_MAX_ATTEMPTS);
  });

  it("dead-letters at once on a 410, and retries while the app isn't live", async () => {
    const { app, subscriptionId } = await appWithSink(acme, "birds", [
      "member.*",
    ]);
    await db
      .update(apps)
      .set({ status: "disabled" })
      .where(eq(apps.id, app.id));
    await emitAndWait(removed(acme));
    expect(appFetch).not.toHaveBeenCalled();
    expect(await deliveriesOf(subscriptionId)).toEqual([
      expect.objectContaining({ status: "pending", lastError: "app_not_live" }),
    ]);
    await db.update(apps).set({ status: "active" }).where(eq(apps.id, app.id));
    appFetch.mockResolvedValue(new Response("gone", { status: 410 }));
    await db.delete(eventDeliveries);
    await emitAndWait(removed(acme));
    expect(await deliveriesOf(subscriptionId)).toEqual([
      expect.objectContaining({ status: "dead", lastStatusCode: 410 }),
    ]);
  });

  it("is the manifest's: an admin can pause it but not change what it receives, and removing it pauses it", async () => {
    const { subscriptionId } = await appWithSink(acme, "birds", ["member.*"]);
    const ctx = { orgId: acme, userId: owner, role: "owner" as const };
    await expect(
      EventSubscriptionService.update(ctx, subscriptionId, { events: ["*"] }),
    ).rejects.toThrow(/belongs to an app/);
    const { subscriptions } = await EventSubscriptionService.list(ctx);
    expect(subscriptions).toEqual([
      expect.objectContaining({ id: subscriptionId, sink: "app", url: null }),
    ]);
    await expect(
      EventSubscriptionService.remove(ctx, subscriptionId),
    ).resolves.toEqual({ removed: false, disabled: true });
    const [row] = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, subscriptionId));
    expect(row).toMatchObject({ enabled: false, events: '["member.*"]' });
  });

  it("goes with the app when the app is deleted", async () => {
    const { app, subscriptionId } = await appWithSink(acme, "birds", [
      "member.*",
    ]);
    await AppRepository.tombstone(app);
    expect(
      await db
        .select()
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.id, subscriptionId)),
    ).toEqual([]);
  });
});
