/**
 * A real SQLite database for repository and service tests: an in-memory
 * libsql database with every gateway migration applied, behind the same
 * Drizzle API the Worker uses with D1.
 *
 * Point the `@/db` module at it with:
 *
 *   const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
 *   vi.mock("@/db", () => ({ db: testDbProxy(testDb) }));
 *   beforeEach(async () => { testDb.current = await createTestDb(); });
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "@/db/schema";

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export async function createTestDb() {
  const db = drizzle(createClient({ url: ":memory:" }), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/** A stand-in for `@/db`'s `db` that forwards to the current test database. */
export function testDbProxy(holder: { current: TestDb | null }): TestDb {
  return new Proxy({} as TestDb, {
    get(_target, property) {
      if (!holder.current) throw new Error("test database not created");
      const value = Reflect.get(holder.current, property);
      return typeof value === "function" ? value.bind(holder.current) : value;
    },
  });
}

let sequence = 0;

/** Insert a user and their membership; returns the user id. */
export async function seedMember(
  db: TestDb,
  options: {
    organizationId: string;
    role?: string;
    email?: string;
    banned?: boolean;
  },
): Promise<string> {
  sequence += 1;
  const userId = `user-${sequence}`;
  await db.insert(schema.users).values({
    id: userId,
    name: `User ${sequence}`,
    email: options.email ?? `user-${sequence}@example.com`,
    banned: options.banned ?? false,
  });
  await db.insert(schema.members).values({
    id: `member-${sequence}`,
    organizationId: options.organizationId,
    userId,
    role: options.role ?? "member",
    createdAt: new Date(),
  });
  return userId;
}

/** Insert an organization; returns its id. */
export async function seedOrganization(
  db: TestDb,
  slug = `org-${(sequence += 1)}`,
): Promise<string> {
  const id = `org-id-${slug}`;
  await db.insert(schema.organizations).values({
    id,
    name: slug,
    slug,
    createdAt: new Date(),
  });
  return id;
}
