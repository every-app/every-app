/**
 * The `providers` table (migration 0013) read into the gateway's registry
 * against a migrated SQLite database: rows in the order they were added,
 * a bound row served and an unbound one left out of what is set, the
 * 30-second cache, and the catalog alone when the table can't be read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});
vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_URL: "https://apps.example.com",
    APP_BASE_DOMAIN: "apps.example.com",
  },
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));

import { providerBindingKey, providerRegistry } from "@every-app/sdk/internal";
import { sql } from "drizzle-orm";
import { providers } from "@/db/schema";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";
import { createTestDb } from "@/test/sqlite-db";
import { gatewayProviders, resetGatewayProvidersForTests } from "./index";

const stripe = {
  id: "stripe",
  name: "Stripe",
  docs: "https://dashboard.stripe.com/apikeys",
  hosts: ["api.stripe.com"],
  auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
};
const exa = {
  id: "exa",
  name: "Exa",
  docs: "https://dashboard.exa.ai/api-keys",
  hosts: ["api.exa.ai"],
  auth: { kind: "header", secret: "EXA_API_KEY", header: "x-api-key" },
};

beforeEach(async () => {
  testDb.current = await createTestDb();
  resetGatewayProvidersForTests();
  vi.useRealTimers();
});

describe("the providers table", () => {
  it("reads rows in the order they were added, with their binding", async () => {
    const [row] = providerRegistry([{ id: "stripe", spec: stripe }]).rows();
    await testDb.current!.insert(providers).values([
      {
        id: "stripe",
        spec: JSON.stringify(stripe),
        addedBy: "ben@example.com",
        addedAt: new Date(2000),
        updatedAt: new Date(2000),
        boundTo: providerBindingKey(row!.capability),
        boundAt: new Date(3000),
      },
      {
        id: "exa",
        spec: JSON.stringify(exa),
        addedBy: "ben@example.com",
        addedAt: new Date(1000),
        updatedAt: new Date(1000),
      },
    ]);
    const rows = await ProviderRepository.all();
    expect(rows.map((each) => each.id)).toEqual(["exa", "stripe"]);
    expect(rows[1]).toMatchObject({
      addedBy: "ben@example.com",
      addedAt: 2000,
    });
    expect(await ProviderRepository.byId("exa")).toMatchObject({
      id: "exa",
      boundTo: null,
    });
    expect(await ProviderRepository.byId("none")).toBeNull();

    const registry = await gatewayProviders();
    expect(registry.sourceOf("stripe")).toBe("row");
    expect(registry.bound("stripe")).toBe(true);
    expect(registry.bound("exa")).toBe(false);
    expect([...registry.unboundSettings()]).toEqual(["EXA_API_KEY"]);
    expect(registry.rejected).toEqual([]);
  });

  it("caches the registry for 30 seconds per isolate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const before = await gatewayProviders();
    expect(before.sourceOf("exa")).toBeUndefined();
    await testDb.current!.insert(providers).values({
      id: "exa",
      spec: JSON.stringify(exa),
      addedAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await gatewayProviders()).sourceOf("exa")).toBeUndefined();
    vi.advanceTimersByTime(31_000);
    expect((await gatewayProviders()).sourceOf("exa")).toBe("row");
  });

  it("serves the catalog alone when the rows can't be read, logging once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await testDb.current!.run(sql`DROP TABLE providers`);
    const registry = await gatewayProviders();
    expect(registry.ids()).toContain("dataforseo");
    expect(registry.rows()).toEqual([]);
    expect(registry.bound("dataforseo")).toBe(true);
    const lines = warn.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .filter((entry) => entry["evt"] === "provider.rows_unavailable");
    expect(lines).toHaveLength(1);
  });
});
