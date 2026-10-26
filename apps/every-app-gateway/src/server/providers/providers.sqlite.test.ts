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

import {
  CAPABILITIES,
  providerBindingKey,
  providerRegistry,
} from "@every-app/sdk/internal";
import { sql } from "drizzle-orm";
import { providerScopeSets, providers } from "@/db/schema";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";
import { createTestDb } from "@/test/sqlite-db";
import { gatewayProviders, resetGatewayProvidersForTests } from "./index";

const northwind = {
  id: "northwind",
  name: "Northwind",
  docs: "https://developer.northwind.io/keys",
  hosts: ["api.northwind.io"],
  auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
};
const contoso = {
  id: "contoso",
  name: "Contoso",
  docs: "https://contoso.dev/docs/auth",
  hosts: ["api.contoso.dev"],
  auth: { kind: "header", secret: "CONTOSO_API_KEY", header: "x-api-key" },
};

beforeEach(async () => {
  testDb.current = await createTestDb();
  resetGatewayProvidersForTests();
  vi.useRealTimers();
});

describe("the providers table", () => {
  it("reads rows in the order they were added, with their binding", async () => {
    const [row] = providerRegistry([
      { id: "northwind", spec: northwind },
    ]).rows();
    await testDb.current!.insert(providers).values([
      {
        id: "northwind",
        spec: JSON.stringify(northwind),
        addedBy: "ben@example.com",
        addedAt: new Date(2000),
        updatedAt: new Date(2000),
        boundTo: providerBindingKey(row!.capability),
        boundAt: new Date(3000),
      },
      {
        id: "contoso",
        spec: JSON.stringify(contoso),
        addedBy: "ben@example.com",
        addedAt: new Date(1000),
        updatedAt: new Date(1000),
      },
    ]);
    const rows = await ProviderRepository.all();
    expect(rows.map((each) => each.id)).toEqual(["contoso", "northwind"]);
    expect(rows[1]).toMatchObject({
      addedBy: "ben@example.com",
      addedAt: 2000,
    });
    expect(await ProviderRepository.byId("contoso")).toMatchObject({
      id: "contoso",
      boundTo: null,
    });
    expect(await ProviderRepository.byId("none")).toBeNull();

    const registry = await gatewayProviders();
    expect(registry.sourceOf("northwind")).toBe("row");
    expect(registry.bound("northwind")).toBe(true);
    expect(registry.bound("contoso")).toBe(false);
    expect([...registry.unboundSettings()]).toEqual(["CONTOSO_API_KEY"]);
    expect(registry.rejected).toEqual([]);
  });

  it("caches the registry for 30 seconds per isolate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const before = await gatewayProviders();
    expect(before.sourceOf("contoso")).toBeUndefined();
    await testDb.current!.insert(providers).values({
      id: "contoso",
      spec: JSON.stringify(contoso),
      addedAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await gatewayProviders()).sourceOf("contoso")).toBeUndefined();
    vi.advanceTimersByTime(31_000);
    expect((await gatewayProviders()).sourceOf("contoso")).toBe("row");
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

describe("the provider_scope_sets table", () => {
  const gmailSend = {
    label: "Gmail (send)",
    access: "write",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    routes: [{ host: "gmail.googleapis.com", paths: ["/gmail/v1/users/"] }],
  };

  it("adds an operator's set to the built-in client, and leaves out one that fails the rules", async () => {
    await testDb.current!.insert(providerScopeSets).values([
      {
        providerId: "google-workspace",
        name: "gmail.send",
        spec: JSON.stringify(gmailSend),
        addedBy: "ops@example.com",
        addedAt: new Date(1000),
        updatedAt: new Date(1000),
      },
      {
        // Its route names a host outside the client's: refused on read.
        providerId: "google-workspace",
        name: "drive.read",
        spec: JSON.stringify({
          ...gmailSend,
          routes: [{ host: "evil.example", paths: ["/"] }],
        }),
        addedBy: "ops@example.com",
        addedAt: new Date(2000),
        updatedAt: new Date(2000),
      },
      {
        // Not an OAuth client with sets.
        providerId: "dataforseo",
        name: "x.read",
        spec: JSON.stringify(gmailSend),
        addedBy: "ops@example.com",
        addedAt: new Date(3000),
        updatedAt: new Date(3000),
      },
    ]);
    const registry = await gatewayProviders();
    const google = registry.get("google-workspace");
    expect(google?.mode).toBe("oauth_client");
    if (google?.mode !== "oauth_client") return;
    expect(Object.keys(google.scopePolicy!.sets)).toContain("gmail.send");
    expect(Object.keys(google.scopePolicy!.sets)).not.toContain("drive.read");
    expect(google.authorize.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
    expect(
      registry
        .scopeSets()
        .map((set) => [set.providerId, set.name, set.addedBy]),
    ).toEqual([["google-workspace", "gmail.send", "ops@example.com"]]);
    expect(
      registry.rejectedScopeSets.map((r) => [r.providerId, r.name, r.code]),
    ).toEqual([
      ["google-workspace", "drive.read", "SCOPE_SET_INVALID"],
      ["dataforseo", "x.read", "SCOPE_SET_PROVIDER_UNKNOWN"],
    ]);
    // The client's binding key doesn't move: an uploaded client stays live.
    expect(providerBindingKey(google)).toBe(
      providerBindingKey(CAPABILITIES["google-workspace"]),
    );
  });

  it("serves the client's own sets alone when the table can't be read", async () => {
    await testDb.current!.run(sql`DROP TABLE provider_scope_sets`);
    const registry = await gatewayProviders();
    const google = registry.get("google-workspace");
    if (google?.mode !== "oauth_client") throw new Error("google");
    expect(Object.keys(google.scopePolicy!.sets)).toEqual(
      Object.keys(CAPABILITIES["google-workspace"].scopePolicy!.sets),
    );
    expect(registry.scopeSets()).toEqual([]);
  });
});
