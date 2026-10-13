import { beforeEach, describe, expect, it } from "vitest";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import { createSqliteD1, sqliteD1Script } from "@/test/sqliteD1";
import {
  forgetOwnedResources,
  readOwnedResources,
  recordOwnedResource,
  recordUploadedVersion,
} from "./ownership";

const DB_ID = "0123456789abcdef0123456789abcdef";
let db: D1Database;

beforeEach(() => {
  // Through `cf d1 query`, as the CLI writes it.
  const cf = new FakeCf().on(["d1"], sqliteD1Script({ [DB_ID]: createSqliteD1() }));
  db = cfD1Database(cf, DB_ID);
});

const todoDb = {
  kind: "d1" as const,
  binding: "DB",
  name: "every-acme-todo",
  resourceId: "uuid-1",
};

describe("app resource records", () => {
  it("keeps what each app created, and replaces a binding's record", async () => {
    await recordOwnedResource(db, "every-acme-todo", { ...todoDb, resourceId: null });
    await recordOwnedResource(db, "every-acme-todo", todoDb);
    await recordOwnedResource(db, "every-acme-chef", {
      ...todoDb,
      name: "every-acme-chef",
      resourceId: "uuid-2",
    });

    await expect(readOwnedResources(db, "every-acme-todo")).resolves.toEqual([
      { ...todoDb, versionId: null },
    ]);
    await forgetOwnedResources(db, "every-acme-todo");
    await expect(readOwnedResources(db, "every-acme-todo")).resolves.toEqual([]);
    await expect(readOwnedResources(db, "every-acme-chef")).resolves.toHaveLength(1);
  });

  it("keeps the version a deploy last uploaded on the Worker's record", async () => {
    const worker = {
      kind: "worker" as const,
      binding: "",
      name: "every-acme-todo",
      resourceId: "every-acme-todo",
    };
    await recordOwnedResource(db, "every-acme-todo", worker);
    await recordOwnedResource(db, "every-acme-todo", todoDb);

    await recordUploadedVersion(db, "every-acme-todo", "version-2");

    await expect(readOwnedResources(db, "every-acme-todo")).resolves.toEqual([
      { ...todoDb, versionId: null },
      { ...worker, versionId: "version-2" },
    ]);
  });

  it("never records one resource, or one name, for two apps", async () => {
    await recordOwnedResource(db, "every-acme-todo", todoDb);

    await expect(
      recordOwnedResource(db, "every-acme-notes", { ...todoDb, binding: "ARCHIVE" }),
    ).rejects.toMatchObject({ code: "RESOURCE_OWNED" });
    await expect(
      recordOwnedResource(db, "every-acme-notes", {
        ...todoDb,
        name: "every-acme-notes",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_OWNED" });
  });
});
