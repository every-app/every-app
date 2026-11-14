import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { composioLinkRequests, composioLinks } from "@/db/schema";
import { open, seal, type SealingEnv } from "@/server/secrets/sealed";

/**
 * One person's Composio linked in an organization, and the sign-in
 * waiting to become one (docs/design/2026-11-composio.md). The user key
 * and the sign-in id are sealed on the way in (`store`, `putRequest`) and
 * opened on the way out (`readKey`, `findRequest`); the link's own shape
 * never carries the key. One row of each per (organization, user). The
 * connections a person made through their link are
 * ProviderConnectionRepository's.
 */

/** A link as the service and the proxy read it: no key. */
export interface ComposioLink {
  organizationId: string;
  userId: string;
  /** How Composio names the account: its email, else its name. */
  accountLabel: string;
  composioOrgId: string;
  composioProjectId: string;
  composioUserId: string;
  /** The session calls go through; null until the first call. */
  sessionId: string | null;
  /** The accounts that session was opened for, as one string; null with no session. */
  sessionAccounts: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A sign-in waiting for approval, its id opened. */
interface ComposioLinkRequest {
  /** Composio's sign-in id; null when it does not open (lost). */
  signInId: string | null;
  expiresAt: number;
}

interface Person {
  organizationId: string;
  userId: string;
}

const listed = {
  organizationId: composioLinks.organizationId,
  userId: composioLinks.userId,
  accountLabel: composioLinks.accountLabel,
  composioOrgId: composioLinks.composioOrgId,
  composioProjectId: composioLinks.composioProjectId,
  composioUserId: composioLinks.composioUserId,
  sessionId: composioLinks.sessionId,
  sessionAccounts: composioLinks.sessionAccounts,
  createdAt: composioLinks.createdAt,
  updatedAt: composioLinks.updatedAt,
};

function shape(row: {
  organizationId: string;
  userId: string;
  accountLabel: string;
  composioOrgId: string;
  composioProjectId: string;
  composioUserId: string;
  sessionId: string | null;
  sessionAccounts: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ComposioLink {
  return {
    ...row,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function ofPerson(person: Person) {
  return and(
    eq(composioLinks.organizationId, person.organizationId),
    eq(composioLinks.userId, person.userId),
  );
}

function requestOfPerson(person: Person) {
  return and(
    eq(composioLinkRequests.organizationId, person.organizationId),
    eq(composioLinkRequests.userId, person.userId),
  );
}

/** The person's link, or null. */
async function find(person: Person): Promise<ComposioLink | null> {
  const [row] = await db
    .select(listed)
    .from(composioLinks)
    .where(ofPerson(person))
    .limit(1);
  return row ? shape(row) : null;
}

/** How many people in the organization have linked. */
async function countForOrganization(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(composioLinks)
    .where(eq(composioLinks.organizationId, organizationId));
  return Number(row?.count ?? 0);
}

/**
 * Write the person's link, replacing any they had. The key is sealed
 * here. No session yet: the first call opens one.
 */
async function store(
  input: Person & {
    key: string;
    accountLabel: string;
    composioOrgId: string;
    composioProjectId: string;
    composioUserId: string;
    now?: Date;
  },
  env: SealingEnv,
): Promise<ComposioLink> {
  const now = input.now ?? new Date();
  const values = {
    keyEnc: await seal(input.key, env),
    accountLabel: input.accountLabel,
    composioOrgId: input.composioOrgId,
    composioProjectId: input.composioProjectId,
    composioUserId: input.composioUserId,
    sessionId: null,
    sessionAccounts: null,
    updatedAt: now,
  };
  const [row] = await db
    .insert(composioLinks)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      createdAt: now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [composioLinks.organizationId, composioLinks.userId],
      set: values,
    })
    .returning(listed);
  return shape(row!);
}

/** The opened key, or null when the link is gone or the key does not open (lost). */
async function readKey(
  person: Person,
  env: SealingEnv,
): Promise<string | null> {
  const [row] = await db
    .select({ keyEnc: composioLinks.keyEnc })
    .from(composioLinks)
    .where(ofPerson(person))
    .limit(1);
  return row ? open(row.keyEnc, env) : null;
}

/** Keep the session calls go through, with the accounts it was opened for. */
async function storeSession(
  person: Person,
  session: { id: string; accounts: string },
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(composioLinks)
    .set({
      sessionId: session.id,
      sessionAccounts: session.accounts,
      updatedAt: now,
    })
    .where(ofPerson(person));
}

/**
 * Unlink: the person's link and any sign-in waiting. False when there was
 * no link. Their connections through it are the caller's to remove first.
 */
async function remove(person: Person): Promise<boolean> {
  await db.delete(composioLinkRequests).where(requestOfPerson(person));
  const removed = await db
    .delete(composioLinks)
    .where(ofPerson(person))
    .returning({ userId: composioLinks.userId });
  return removed.length > 0;
}

/** Remove every link and waiting sign-in in an organization (Composio was turned off); the links removed. */
async function removeForOrganization(organizationId: string): Promise<number> {
  await db
    .delete(composioLinkRequests)
    .where(eq(composioLinkRequests.organizationId, organizationId));
  const removed = await db
    .delete(composioLinks)
    .where(eq(composioLinks.organizationId, organizationId))
    .returning({ userId: composioLinks.userId });
  return removed.length;
}

/** Keep a sign-in waiting for approval, replacing any earlier one. The id is sealed here. */
async function putRequest(
  input: Person & { signInId: string; expiresAt: number; now?: Date },
  env: SealingEnv,
): Promise<void> {
  const values = {
    signInEnc: await seal(input.signInId, env),
    expiresAt: new Date(input.expiresAt),
    createdAt: input.now ?? new Date(),
  };
  await db
    .insert(composioLinkRequests)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        composioLinkRequests.organizationId,
        composioLinkRequests.userId,
      ],
      set: values,
    });
}

/** The person's sign-in waiting for approval, or null. */
async function findRequest(
  person: Person,
  env: SealingEnv,
): Promise<ComposioLinkRequest | null> {
  const [row] = await db
    .select()
    .from(composioLinkRequests)
    .where(requestOfPerson(person))
    .limit(1);
  if (!row) return null;
  return {
    signInId: await open(row.signInEnc, env),
    expiresAt: row.expiresAt.getTime(),
  };
}

async function removeRequest(person: Person): Promise<void> {
  await db.delete(composioLinkRequests).where(requestOfPerson(person));
}

export const ComposioLinkRepository = {
  find,
  countForOrganization,
  store,
  readKey,
  storeSession,
  remove,
  removeForOrganization,
  putRequest,
  findRequest,
  removeRequest,
} as const;
