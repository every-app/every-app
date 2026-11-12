import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { oauthStates } from "@/db/schema";
import type { ConnectionKey } from "./ProviderConnectionRepository";
import { storedStrings } from "./stored-strings";

/**
 * The connects in progress (docs/design/2026-11-oauth-one-connection.md):
 * one row per `state`, holding the PKCE verifier, who started it, in
 * which app, the scopes asked for and where to return. `take` reads and
 * deletes in one go, so a state is used once; `put` deletes every expired
 * row first.
 */
export enum OAuthStatePurpose {
  /** The provider sends it back to the callback: a connect from inside an app. */
  Authorize = "authorize",
  /** The Gateway's own Allow page posts it: the connection already holds what the app lists. */
  Allow = "allow",
  /**
   * The provider sends it back to the callback: Reconnect on Your
   * connections → Accounts, which also allows every app the person had
   * allowed for what it lists now.
   */
  Reconnect = "reconnect",
}

const PURPOSES = new Set<string>(Object.values(OAuthStatePurpose));

function purposeOf(value: string): OAuthStatePurpose {
  if (!PURPOSES.has(value)) {
    throw new Error(`Unknown OAuth state purpose: ${value}`);
  }
  return value as OAuthStatePurpose;
}

interface OAuthState {
  state: string;
  providerId: string;
  organizationId: string;
  userId: string;
  appRowId: string;
  purpose: OAuthStatePurpose;
  codeVerifier: string;
  /** The scopes asked for: the provider's spelling (authorize), or the app's, canonical (allow). */
  scopes: string[];
  returnTo: string | null;
  createdAt: number;
  expiresAt: number;
}

/** How long a started flow waits for the provider's callback. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function shape(row: typeof oauthStates.$inferSelect): OAuthState {
  return {
    state: row.state,
    providerId: row.providerId,
    organizationId: row.organizationId,
    userId: row.userId,
    appRowId: row.appRowId,
    purpose: purposeOf(row.purpose),
    codeVerifier: row.codeVerifier,
    scopes: storedStrings(row.scopes),
    returnTo: row.returnTo,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

async function put(input: {
  state: string;
  providerId: string;
  organizationId: string;
  userId: string;
  appRowId: string;
  purpose: OAuthStatePurpose;
  codeVerifier: string;
  scopes: readonly string[];
  returnTo: string | null;
  now?: Date;
}): Promise<OAuthState> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
  const [row] = await db
    .insert(oauthStates)
    .values({
      state: input.state,
      providerId: input.providerId,
      organizationId: input.organizationId,
      userId: input.userId,
      appRowId: input.appRowId,
      purpose: input.purpose,
      codeVerifier: input.codeVerifier,
      scopes: JSON.stringify([...input.scopes]),
      returnTo: input.returnTo,
      createdAt: now,
      expiresAt,
    })
    .returning();
  return shape(row!);
}

/** The row for `state`, left in place; null when there is none or it expired. */
async function peek(
  state: string,
  now: Date = new Date(),
): Promise<OAuthState | null> {
  const [row] = await db
    .select()
    .from(oauthStates)
    .where(eq(oauthStates.state, state))
    .limit(1);
  if (!row || row.expiresAt.getTime() < now.getTime()) return null;
  return shape(row);
}

/**
 * The row for `state`, deleted as it is read; null when there is none or
 * it expired (an expired row is deleted too, and not returned).
 */
async function take(
  state: string,
  now: Date = new Date(),
): Promise<OAuthState | null> {
  const [row] = await db
    .delete(oauthStates)
    .where(eq(oauthStates.state, state))
    .returning();
  if (!row) return null;
  if (row.expiresAt.getTime() < now.getTime()) return null;
  return shape(row);
}

/**
 * Delete a person's unspent `allow` states for a provider (they connected
 * again, and an open Allow page showed the connection as it was); the
 * count.
 */
async function removeAllow(input: ConnectionKey): Promise<number> {
  const removed = await db
    .delete(oauthStates)
    .where(
      and(
        eq(oauthStates.purpose, OAuthStatePurpose.Allow),
        eq(oauthStates.organizationId, input.organizationId),
        eq(oauthStates.providerId, input.providerId),
        eq(oauthStates.userId, input.userId),
      ),
    )
    .returning({ state: oauthStates.state });
  return removed.length;
}

/** Delete every expired row; the count. */
async function purgeExpired(now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(oauthStates)
    .where(lt(oauthStates.expiresAt, now))
    .returning({ state: oauthStates.state });
  return removed.length;
}

export const OAuthStateRepository = {
  put,
  peek,
  take,
  removeAllow,
  purgeExpired,
} as const;
