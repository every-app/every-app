/**
 * Usage reports against a migrated SQLite database: the report a seeded
 * Gateway builds, when it is sent and when not, the switch, and that a
 * receiver that is down never breaks the hourly job. Nothing here reaches
 * a network: `send` is a stand-in.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { USAGE_REPORT_ENDPOINT } from "@every-app/sdk/internal";
import { eq } from "drizzle-orm";
import {
  apps,
  mcpToolCalls,
  organizations,
  sessions,
  telemetryState,
  usageDaily,
} from "@/db/schema";
import type { OrgContext } from "@/server/organization/orgContext";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { runUsageReport, setUsageReports, usageReportStatus } from "./report";

const example = JSON.parse(
  readFileSync(
    new URL("../../../../telemetry/example-report.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The Gateway got usage reports at SINCE; reports are for the day before `now`. */
const SINCE = Date.parse("2026-11-10T12:00:00Z");
const NOW = new Date("2026-11-21T00:17:00Z");
const YESTERDAY = "2026-11-20";
const at = (time: string) => new Date(`${time}Z`);

/** A self-hosted Gateway on a published release. */
const PUBLISHED = {
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  EVERYAPP_RELEASE: { version: "0.4.2", sha256: "x", published: true },
};

describe("usage reports (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let member: string;
  let send: ReturnType<typeof vi.fn<typeof fetch>>;
  let logged: ReturnType<typeof vi.spyOn>;
  const ctx = (userId: string, role: OrgContext["role"]): OrgContext =>
    ({
      orgId: acme,
      userId,
      role,
      actor: { kind: "user", id: userId },
    }) as OrgContext;
  const state = async () =>
    (await db.select().from(telemetryState).limit(1))[0]!;
  const setState = (values: Partial<typeof telemetryState.$inferInsert>) =>
    db.update(telemetryState).set(values);
  const sent = () =>
    send.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    send = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    acme = await seedOrganization(db, "acme");
    await db
      .update(organizations)
      .set({ createdAt: at("2026-10-05T09:00:00") })
      .where(eq(organizations.id, acme));
    owner = await seedMember(db, { organizationId: acme, role: "owner" });
    member = await seedMember(db, { organizationId: acme });
    // A new Gateway whose first day has passed.
    await setState({ existing: false, createdAt: new Date(SINCE) });
  });

  async function seedUse() {
    const third = await seedMember(db, { organizationId: acme });
    await db.insert(apps).values([
      {
        id: "app-seo",
        organizationId: acme,
        appSlug: "openseo",
        name: "OpenSEO",
        description: "",
      },
      {
        id: "app-pay",
        organizationId: acme,
        appSlug: "acme-payroll",
        name: "Acme Payroll",
        description: "",
      },
      {
        id: "app-old",
        organizationId: acme,
        appSlug: "old",
        name: "Old",
        description: "",
        status: "disabled",
      },
    ]);
    const call = (
      id: string,
      userId: string,
      appRowId: string,
      when: string,
      decision = "allowed",
    ) => ({
      id,
      createdAt: at(when),
      organizationId: acme,
      userId,
      credentialKind: "oauth",
      credentialId: "mcpc_1",
      clientName: "Claude",
      surface: "app",
      appRowId,
      appSlug: "x",
      toolName: "secret_tool_name",
      decision,
      outcome: "ok",
    });
    await db.insert(mcpToolCalls).values([
      ...Array.from({ length: 37 }, (_, i) =>
        call(`c${i}`, owner, "app-seo", "2026-11-20T10:00:00"),
      ),
      call("p1", member, "app-pay", "2026-11-20T11:00:00"),
      call("p2", member, "app-pay", "2026-11-20T23:59:59"),
      call("blocked", member, "app-pay", "2026-11-20T12:00:00", "blocked"),
      // Other days don't count for the day; the 15th counts for the week.
      call("today", third, "app-seo", "2026-11-21T00:05:00"),
      call("week", third, "app-seo", "2026-11-15T10:00:00"),
    ]);
    await db.insert(usageDaily).values([
      {
        organizationId: acme,
        appRowId: "app-seo",
        userId: member,
        kind: "ai",
        target: "openai",
        day: YESTERDAY,
        calls: 5,
        updatedAt: NOW,
      },
      {
        organizationId: acme,
        appRowId: "app-seo",
        userId: "",
        kind: "ai",
        target: "openai",
        day: YESTERDAY,
        calls: 9,
        updatedAt: NOW,
      },
    ]);
    return third;
  }

  it("builds the report from counts alone, with the example's keys", async () => {
    await seedUse();
    const status = await usageReportStatus(NOW, PUBLISHED);
    const { install } = status.nextReport!;
    expect(install).toMatch(/^[0-9a-f]{32}$/);
    expect(status.nextReport).toEqual({
      schema: 1,
      install,
      day: YESTERDAY,
      version: "0.4.2",
      installed: "2026-10",
      members: 3,
      // The owner and the member; the third person only on other days.
      active_members_1d: 2,
      active_members_7d: 3,
      // The disabled app isn't counted.
      apps: 2,
      app_use_1d: [
        { app: "openseo", active_members: 2, tool_calls: 30 },
        { app: "other", active_members: 1, tool_calls: 2 },
      ],
    });
    expect(Object.keys(status.nextReport!)).toEqual(Object.keys(example));
    // Nothing the seed named reaches the report.
    expect(JSON.stringify(status.nextReport)).not.toMatch(
      /acme|payroll|example\.com|secret_tool_name|Claude|User /i,
    );
  });

  it("counts someone who only opened pages, by their session", async () => {
    await db.insert(sessions).values({
      id: "s1",
      token: "t1",
      userId: member,
      expiresAt: at("2026-11-27T00:00:00"),
      updatedAt: at("2026-11-20T09:00:00"),
    });
    const { nextReport } = await usageReportStatus(NOW, PUBLISHED);
    expect(nextReport).toMatchObject({
      active_members_1d: 1,
      active_members_7d: 1,
      app_use_1d: [],
    });
  });

  it("sends yesterday's report once, to our receiver and nowhere else", async () => {
    await seedUse();
    expect(await runUsageReport(PUBLISHED, NOW, send)).toBe("sent");
    expect(
      await runUsageReport(PUBLISHED, new Date(NOW.getTime() + HOUR), send),
    ).toBe("done");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.url).toBe(USAGE_REPORT_ENDPOINT);
    expect(sent()[0]!.body).toMatchObject({ day: YESTERDAY, members: 3 });
    expect(send.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    // The page shows what went.
    const status = await usageReportStatus(NOW, PUBLISHED);
    expect(status.lastReport).toEqual(sent()[0]!.body);
    expect(status.lastReportedDay).toBe(YESTERDAY);
    // The next day's goes the next day, with the same id.
    expect(
      await runUsageReport(PUBLISHED, new Date(NOW.getTime() + DAY), send),
    ).toBe("sent");
    expect(sent()[1]!.body).toMatchObject({
      day: "2026-11-21",
      install: sent()[0]!.body["install"],
    });
  });

  it("sends nothing from a build that isn't a published release, a hosted Gateway, or one with the setting", async () => {
    const checkout = {
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      EVERYAPP_RELEASE: { version: "0.4.2", sha256: "x" },
    };
    expect(await runUsageReport(checkout, NOW, send)).toBe("unpublished");
    expect(
      await runUsageReport(
        {
          GATEWAY_DEPLOYMENT_MODE: "self_hosted",
          EVERYAPP_RELEASE: { version: "dev" },
        },
        NOW,
        send,
      ),
    ).toBe("unpublished");
    expect(
      await runUsageReport(
        { ...PUBLISHED, GATEWAY_DEPLOYMENT_MODE: "hosted" },
        NOW,
        send,
      ),
    ).toBe("unavailable");
    expect(
      await runUsageReport(
        { EVERYAPP_RELEASE: PUBLISHED.EVERYAPP_RELEASE },
        NOW,
        send,
      ),
    ).toBe("unavailable");
    for (const value of ["1", "true", "yes"]) {
      expect(
        await runUsageReport(
          { ...PUBLISHED, TELEMETRY_DISABLED: value },
          NOW,
          send,
        ),
      ).toBe("setting");
    }
    expect(send).not.toHaveBeenCalled();
    // "0", "false" and "off" leave reports on.
    expect(
      await runUsageReport(
        { ...PUBLISHED, TELEMETRY_DISABLED: "false" },
        NOW,
        send,
      ),
    ).toBe("sent");

    // A build from source still shows what it would send.
    const status = await usageReportStatus(NOW, checkout);
    expect(status).toMatchObject({
      usageReports: "off",
      reason: "unpublished",
      canChange: true,
      notice: null,
    });
    expect(status.nextReport).not.toBeNull();
    // The setting can't be overridden from the page.
    const disabled = { ...PUBLISHED, TELEMETRY_DISABLED: "1" };
    expect(await usageReportStatus(NOW, disabled)).toMatchObject({
      usageReports: "off",
      reason: "setting",
      canChange: false,
      nextReport: null,
    });
    await expect(
      setUsageReports(ctx(owner, "owner"), true, NOW, disabled),
    ).rejects.toThrow(/TELEMETRY_DISABLED/);
  });

  it("waits a day on a new Gateway", async () => {
    const early = new Date(SINCE + 23 * HOUR);
    expect(await runUsageReport(PUBLISHED, early, send)).toBe("waiting");
    expect(send).not.toHaveBeenCalled();
    const status = await usageReportStatus(early, PUBLISHED);
    expect(status).toMatchObject({
      usageReports: "on",
      startsAt: "2026-11-11T12:00:00.000Z",
    });
    expect(status.notice?.headline).toBe(
      "Usage reports start on 11 November for this Gateway.",
    );
    expect(
      await runUsageReport(PUBLISHED, new Date(SINCE + 25 * HOUR), send),
    ).toBe("sent");
  });

  it("waits out the notice on a Gateway that existed before usage reports, and stays off if turned off meanwhile", async () => {
    await setState({ existing: true });
    const sixDays = new Date(SINCE + 6 * DAY);
    expect(await runUsageReport(PUBLISHED, sixDays, send)).toBe("waiting");
    const status = await usageReportStatus(sixDays, PUBLISHED);
    expect(status.notice).toEqual({
      headline: "Usage reports start on 17 November for this Gateway.",
      detail:
        "Once a day it will send Every App a few rounded counts: members, apps, how many people used each app, AI tool calls, the version. Never your domain, names, emails or anything inside an app.",
    });
    expect(
      await runUsageReport(PUBLISHED, new Date(SINCE + 7 * DAY + HOUR), send),
    ).toBe("sent");
    expect((await usageReportStatus(NOW, PUBLISHED)).notice).toBeNull();

    // Turned off during the notice: nothing is ever sent.
    send.mockClear();
    await setState({ reportedDay: null, attemptDay: null, attempts: 0 });
    await setUsageReports(ctx(owner, "owner"), false, sixDays, PUBLISHED);
    expect(
      await runUsageReport(PUBLISHED, new Date(SINCE + 8 * DAY), send),
    ).toBe("off");
    expect(send).not.toHaveBeenCalled();
  });

  it("stops at once when an owner or admin turns it off, and deletes the id", async () => {
    await runUsageReport(PUBLISHED, NOW, send);
    const before = (await state()).installId;
    expect(before).toMatch(/^[0-9a-f]{32}$/);

    await expect(
      setUsageReports(ctx(member, "member"), false, NOW, PUBLISHED),
    ).rejects.toThrow(/owners and admins/);
    const off = await setUsageReports(
      ctx(owner, "admin"),
      false,
      NOW,
      PUBLISHED,
    );
    expect(off).toMatchObject({
      usageReports: "off",
      reason: "off",
      changed: true,
      nextReport: null,
      lastReport: null,
      notice: null,
    });
    expect(await state()).toMatchObject({
      enabled: false,
      installId: null,
      lastPayload: null,
      changedBy: owner,
    });
    expect(
      await runUsageReport(PUBLISHED, new Date(NOW.getTime() + DAY), send),
    ).toBe("off");
    expect(send).toHaveBeenCalledTimes(1);

    // On again: a new id, and reports resume.
    const on = await setUsageReports(ctx(owner, "owner"), true, NOW, PUBLISHED);
    expect(on).toMatchObject({ usageReports: "on", changed: true });
    expect(on.nextReport!.install).not.toBe(before);
    expect(
      await setUsageReports(ctx(owner, "owner"), true, NOW, PUBLISHED),
    ).toMatchObject({ changed: false });
    expect(
      await runUsageReport(PUBLISHED, new Date(NOW.getTime() + DAY), send),
    ).toBe("sent");
  });

  it("never throws when the receiver is down, and stops trying after three tries a day", async () => {
    send.mockRejectedValue(new Error("network down"));
    for (let hour = 0; hour < 3; hour += 1) {
      expect(
        await runUsageReport(
          PUBLISHED,
          new Date(NOW.getTime() + hour * HOUR),
          send,
        ),
      ).toBe("failed");
    }
    expect(
      await runUsageReport(PUBLISHED, new Date(NOW.getTime() + 3 * HOUR), send),
    ).toBe("done");
    expect(send).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledTimes(3);
    expect((await state()).reportedDay).toBeNull();

    // A refusal is a failure too; the next day starts over.
    send.mockResolvedValue(new Response("Refused: keys\n", { status: 400 }));
    expect(
      await runUsageReport(PUBLISHED, new Date(NOW.getTime() + DAY), send),
    ).toBe("failed");
    send.mockResolvedValue(new Response(null, { status: 204 }));
    expect(
      await runUsageReport(
        PUBLISHED,
        new Date(NOW.getTime() + DAY + HOUR),
        send,
      ),
    ).toBe("sent");
  });

  it("sends nothing before anyone has claimed the Gateway", async () => {
    testDb.current = db = await createTestDb();
    await setState({ existing: false, createdAt: new Date(SINCE) });
    expect(await runUsageReport(PUBLISHED, NOW, send)).toBe("not_set_up");
    expect(send).not.toHaveBeenCalled();
  });

  it("the migration records whether the Gateway already had an owner", async () => {
    // createTestDb ran every migration on an empty database: a new Gateway.
    const fresh = await createTestDb();
    expect((await fresh.select().from(telemetryState))[0]).toMatchObject({
      id: "telemetry",
      existing: false,
      enabled: null,
    });
  });
});
