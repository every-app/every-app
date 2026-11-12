import { and, asc, eq, inArray, not } from "drizzle-orm";
import { db } from "@/db";
import { apps, providerAppAccess } from "@/db/schema";
import { accessToApp } from "./effective-access";
import type { ConnectionKey } from "./ProviderConnectionRepository";
import { storedStrings } from "./stored-strings";

/**
 * The apps a person allowed to use their connection to an OAuth provider
 * (docs/design/2026-11-oauth-one-connection.md): one row per
 * (organization, provider, user, app), with the scopes the app listed
 * when they allowed it. An app with no row can't use the connection. The
 * lifecycle deletes here are an app's: the person took its access away
 * (`remove`), or lost the app (`removeForMemberApp`,
 * `pruneWithoutAccess`). A connection going takes its rows with it
 * (ProviderConnectionRepository), and so does the person connecting
 * another account (`removeForConnection`).
 */
interface ProviderAppAccess {
  providerId: string;
  userId: string;
  /** apps.id of the app allowed. */
  appRowId: string;
  /** The scopes the app listed when the person allowed it, canonical. */
  scopes: string[];
}

type AccessKey = ConnectionKey & { appRowId: string };

function shape(row: typeof providerAppAccess.$inferSelect): ProviderAppAccess {
  return {
    providerId: row.providerId,
    userId: row.userId,
    appRowId: row.appRowId,
    scopes: storedStrings(row.scopes),
  };
}

function ofConnection(key: ConnectionKey) {
  return and(
    eq(providerAppAccess.organizationId, key.organizationId),
    eq(providerAppAccess.providerId, key.providerId),
    eq(providerAppAccess.userId, key.userId),
  );
}

function keyed(key: AccessKey) {
  return and(ofConnection(key), eq(providerAppAccess.appRowId, key.appRowId));
}

/** The access the person gave the app to their connection, or null. */
async function find(key: AccessKey): Promise<ProviderAppAccess | null> {
  const [row] = await db
    .select()
    .from(providerAppAccess)
    .where(keyed(key))
    .limit(1);
  return row ? shape(row) : null;
}

/** Every access row in an organization, oldest first. */
async function listByOrganization(
  organizationId: string,
): Promise<ProviderAppAccess[]> {
  const rows = await db
    .select()
    .from(providerAppAccess)
    .where(eq(providerAppAccess.organizationId, organizationId))
    .orderBy(asc(providerAppAccess.createdAt), asc(providerAppAccess.appRowId));
  return rows.map(shape);
}

/** The apps one person allowed to use their connection to a provider, oldest first. */
async function listForConnection(
  key: ConnectionKey,
): Promise<ProviderAppAccess[]> {
  const rows = await db
    .select()
    .from(providerAppAccess)
    .where(ofConnection(key))
    .orderBy(asc(providerAppAccess.createdAt), asc(providerAppAccess.appRowId));
  return rows.map(shape);
}

/**
 * The person allows the app, for the scopes it lists now: a new row, or
 * the scopes of the one they had replaced (`createdAt` stays).
 */
async function allow(
  input: AccessKey & { scopes: readonly string[]; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const scopes = JSON.stringify([...input.scopes]);
  await db
    .insert(providerAppAccess)
    .values({
      organizationId: input.organizationId,
      providerId: input.providerId,
      userId: input.userId,
      appRowId: input.appRowId,
      scopes,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        providerAppAccess.organizationId,
        providerAppAccess.providerId,
        providerAppAccess.userId,
        providerAppAccess.appRowId,
      ],
      set: { scopes, updatedAt: now },
    });
}

/** Take one app's access away; false when it had none. */
async function remove(key: AccessKey): Promise<boolean> {
  const removed = await db
    .delete(providerAppAccess)
    .where(keyed(key))
    .returning({ appRowId: providerAppAccess.appRowId });
  return removed.length > 0;
}

/**
 * Take every app's access to one person's connection away (they connected
 * another account, which no app was allowed to use, or the connection
 * went).
 */
async function removeForConnection(key: ConnectionKey): Promise<void> {
  await db.delete(providerAppAccess).where(ofConnection(key));
}

/** Take a member's access rows for one app away (they lost the app). */
async function removeForMemberApp(input: {
  organizationId: string;
  userId: string;
  appRowId: string;
}): Promise<void> {
  await db
    .delete(providerAppAccess)
    .where(
      and(
        eq(providerAppAccess.organizationId, input.organizationId),
        eq(providerAppAccess.userId, input.userId),
        eq(providerAppAccess.appRowId, input.appRowId),
      ),
    );
}

/**
 * Take away the access rows in an organization's own apps whose person
 * no longer opens the app (a grant revoked, a group changed or deleted,
 * "Available to everyone" turned off); the count. Shared apps have no
 * grants, so theirs stay. The connections stay: other apps may use them.
 */
async function pruneWithoutAccess(organizationId: string): Promise<number> {
  const removed = await db
    .delete(providerAppAccess)
    .where(
      and(
        eq(providerAppAccess.organizationId, organizationId),
        inArray(
          providerAppAccess.appRowId,
          db
            .select({ id: apps.id })
            .from(apps)
            .where(
              and(
                eq(apps.organizationId, organizationId),
                eq(apps.scope, "org"),
                not(accessToApp(providerAppAccess.userId, organizationId)),
              ),
            ),
        ),
      ),
    )
    .returning({ appRowId: providerAppAccess.appRowId });
  return removed.length;
}

export const ProviderAppAccessRepository = {
  find,
  listByOrganization,
  listForConnection,
  allow,
  remove,
  removeForConnection,
  removeForMemberApp,
  pruneWithoutAccess,
} as const;
