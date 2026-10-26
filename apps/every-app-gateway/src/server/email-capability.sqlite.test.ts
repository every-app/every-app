/**
 * App mail through the AppGateway entrypoint against a migrated SQLite
 * database: the `app` budgets count in `rate_limit_counters`, per address
 * and per gateway, with the repositories and mail module the Worker uses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const send = vi.hoisted(() => vi.fn());

vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    EMAIL: { send },
    EMAIL_FROM: "noreply@gateway.example.com",
    EMAIL_FROM_NAME: "EveryApp",
  },
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { InMemoryAppRegistry } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import { rateLimitCounters } from "@/db/schema";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { createTestDb } from "@/test/sqlite-db";

const SEND = "http://every-app-gateway.internal/api/integrations/email/send";

describe("app mail budgets (SQLite)", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    send.mockReset().mockResolvedValue({ messageId: "<m@example.com>" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  function mail(to: string | string[]) {
    return handleAppGatewayRequest({
      request: new Request(SEND, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, subject: "Re: your ticket", text: "Hi" }),
      }),
      props: {
        organizationId: "org-acme",
        appId: "inbox",
        workerName: "every-acme-inbox",
      },
      env: { GATEWAY_DEPLOYMENT_MODE: "self_hosted" },
      registry: new InMemoryAppRegistry([
        {
          appId: "inbox",
          hostname: "inbox.example.com",
          workerName: "every-acme-inbox",
          tier: "service_binding",
          scope: "org",
          organizationId: "org-acme",
          status: "active",
          manifest: validateManifest({
            id: "inbox",
            capabilities: { email: { access: "write" } },
          }),
        },
      ]),
      organizations: { isAttributable: async () => true },
    });
  }

  it("refuses with 429 once an address has had its app mail for the day", async () => {
    for (let i = 0; i < 100; i += 1) {
      const response = await mail("customer@example.net");
      expect(response.status, `mail ${i + 1}`).toBe(200);
    }
    const refused = await mail("Customer@Example.net");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "email_budget_exhausted",
    );
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(100);

    // Another address still gets its mail; the gateway counted them all.
    expect((await mail("other@example.net")).status).toBe(200);
    const day = new Date().toISOString().slice(0, 10);
    const rows = await db.select().from(rateLimitCounters);
    const counts = Object.fromEntries(rows.map((row) => [row.key, row.count]));
    expect(counts[`mail:app:gateway:${day}`]).toBe(101);
    // Per address and per gateway only: no organization in any key, and no
    // address either.
    expect(rows).toHaveLength(3);
    for (const { key } of rows) {
      expect(key).toMatch(
        /^mail:app:(gateway|to:[0-9a-f]{32}):\d{4}-\d{2}-\d{2}$/,
      );
      expect(key).not.toContain("org-acme");
    }
  });

  it("counts a message once for each distinct recipient", async () => {
    expect(
      (await mail(["a@example.net", "b@example.net", "A@example.net"])).status,
    ).toBe(200);
    const day = new Date().toISOString().slice(0, 10);
    const rows = await db.select().from(rateLimitCounters);
    expect(
      rows.find((row) => row.key === `mail:app:gateway:${day}`)?.count,
    ).toBe(2);
    expect(rows).toHaveLength(3);
  });
});
