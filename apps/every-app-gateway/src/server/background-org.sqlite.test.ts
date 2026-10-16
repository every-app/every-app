/**
 * Background work from a shared app, against a migrated SQLite database:
 * which organizations its `x-everyapp-org` may name (active, with a live
 * member), and the per-organization daily cap on capability calls counted
 * in `rate_limit_counters`, through the AppGateway entrypoint with the
 * repositories the Worker uses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { eq } from "drizzle-orm";
import { InMemoryAppRegistry } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import { organizations, users } from "@/db/schema";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const SERP =
  "http://every-app-gateway.internal/api/integrations/dataforseo/api.dataforseo.com/v3/serp/google/organic/live/advanced";

describe("background organization attribution (SQLite)", () => {
  let db: TestDb;
  let platform: string;
  let acme: string;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    platform = await seedOrganization(db, "every-app");
    await seedMember(db, { organizationId: platform, role: "owner" });
    acme = await seedOrganization(db, "acme");
    await seedMember(db, { organizationId: acme, role: "owner" });
  });

  async function setStatus(organizationId: string, status: string) {
    await db
      .update(organizations)
      .set({ status })
      .where(eq(organizations.id, organizationId));
  }

  it("names an active organization with a live member, and nothing else", async () => {
    expect(await OrganizationRepository.isAttributable(acme)).toBe(true);
    expect(await OrganizationRepository.isAttributable("org-unknown")).toBe(
      false,
    );

    await setStatus(acme, "suspended");
    expect(await OrganizationRepository.isAttributable(acme)).toBe(false);
    await setStatus(acme, "active");

    // No members at all, or only deactivated ones: nobody to work for.
    const empty = await seedOrganization(db, "empty");
    expect(await OrganizationRepository.isAttributable(empty)).toBe(false);
    const banned = await seedOrganization(db, "banned");
    const bannedUser = await seedMember(db, {
      organizationId: banned,
      banned: true,
    });
    expect(await OrganizationRepository.isAttributable(banned)).toBe(false);

    // A ban that has run out is no ban (as isUserBanned reads it); one
    // still to run is.
    const now = new Date();
    await db
      .update(users)
      .set({ banExpires: new Date(now.getTime() - 60_000) })
      .where(eq(users.id, bannedUser));
    expect(await OrganizationRepository.isAttributable(banned, now)).toBe(true);
    await db
      .update(users)
      .set({ banExpires: new Date(now.getTime() + 60_000) })
      .where(eq(users.id, bannedUser));
    expect(await OrganizationRepository.isAttributable(banned, now)).toBe(
      false,
    );
  });

  function backgroundCall(organizationId: string) {
    return handleAppGatewayRequest({
      request: new Request(SERP, {
        method: "POST",
        headers: { "x-everyapp-org": organizationId },
        body: "[]",
      }),
      props: {
        organizationId: platform,
        appId: "openseo",
        workerName: "every-openseo",
      },
      env: {
        GATEWAY_DEPLOYMENT_MODE: "hosted",
        INTEGRATION_ORG_DAILY_LIMIT: "2",
        DATAFORSEO_API_KEY: "login@example.com:secret",
      },
      registry: new InMemoryAppRegistry([
        {
          appId: "openseo",
          hostname: "openseo.example.com",
          workerName: "every-openseo",
          tier: "service_binding",
          scope: "shared",
          organizationId: platform,
          status: "active",
          manifest: validateManifest({
            id: "openseo",
            capabilities: { dataforseo: { access: "read", why: "Research" } },
          }),
        },
      ]),
      organizations: OrganizationRepository,
      counters: RateLimitCounterRepository,
      fetchUpstream: async () => Response.json({ ok: true }),
    });
  }

  it("serves a shared app's background work for the organization it names, up to its daily cap", async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = await backgroundCall(acme);
      expect(response.status).toBe(200);
      await response.text();
    }
    const capped = await backgroundCall(acme);
    expect(capped.status).toBe(429);
    expect(capped.headers.get("retry-after")).toMatch(/^\d+$/);

    // The platform organization's own budget is untouched.
    expect((await backgroundCall(platform)).status).toBe(200);
  });

  it("refuses background work for a suspended or unknown organization", async () => {
    await setStatus(acme, "suspended");
    for (const organizationId of [acme, "org-unknown"]) {
      const response = await backgroundCall(organizationId);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "caller_org_not_attributable",
      });
    }
  });
});
