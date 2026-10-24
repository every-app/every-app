/**
 * Renaming the organization (Manage workspace → Rename) against a migrated
 * SQLite database: an owner or admin renames it and the name follows the
 * shared rule, the slug stays, the event says who; a member is refused; a
 * bad name is refused with nothing written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { eq } from "drizzle-orm";
import { organizations } from "@/db/schema";
import { OrganizationService } from "@/server/services/OrganizationService";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

type Role = "owner" | "admin" | "member";

describe("renaming the organization (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let admin: string;
  let member: string;
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    acme = await seedOrganization(db, "acme");
    owner = await seedMember(db, { organizationId: acme, role: "owner" });
    admin = await seedMember(db, { organizationId: acme, role: "admin" });
    member = await seedMember(db, { organizationId: acme, role: "member" });
  });

  const as = (userId: string, role: Role) => ({ orgId: acme, userId, role });
  const row = async () =>
    (
      await db
        .select({ name: organizations.name, slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, acme))
    )[0];
  const events = () =>
    logged.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((event) => event["evt"] === "organization.renamed");

  it("lets an admin rename it: the rule's name, the slug kept, the event saying who", async () => {
    await expect(
      OrganizationService.rename(as(admin, "admin"), "  Acme   Rockets "),
    ).resolves.toEqual({ id: acme, name: "Acme Rockets" });

    expect(await row()).toEqual({ name: "Acme Rockets", slug: "acme" });
    expect(events()).toEqual([
      {
        evt: "organization.renamed",
        organizationId: acme,
        by: admin,
        name: "Acme Rockets",
      },
    ]);
  });

  it("lets the owner rename it too", async () => {
    await OrganizationService.rename(as(owner, "owner"), "Acme Corp");
    expect(await row()).toEqual({ name: "Acme Corp", slug: "acme" });
  });

  it("refuses a member", async () => {
    await expect(
      OrganizationService.rename(as(member, "member"), "Mine Now"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await row()).toEqual({ name: "acme", slug: "acme" });
    expect(events()).toEqual([]);
  });

  it("refuses a bad name and writes nothing", async () => {
    for (const name of ["", "   ", "x".repeat(65), "Acme\nRockets"]) {
      await expect(
        OrganizationService.rename(as(admin, "admin"), name),
        JSON.stringify(name),
      ).rejects.toMatchObject({
        code: "INVALID_ORGANIZATION_NAME",
        message: "Use 1 to 64 characters with no line breaks.",
      });
    }
    expect(await row()).toEqual({ name: "acme", slug: "acme" });
    expect(events()).toEqual([]);
  });
});
