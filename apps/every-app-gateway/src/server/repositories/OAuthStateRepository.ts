import { eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { oauthStates } from "@/db/schema";

/**
 * The authorize flows in progress (docs/design/2026-10-oauth-providers.md
 * section 5): one row per `state` the provider will send back, holding the
 * PKCE verifier, who started it, for which account, which scope sets and
 * where to return. `take` reads and deletes in one go, so a state is used
 * once; `put` deletes every expired row first.
 */
interface OAuthState {
  state: string;
  providerId: string;
  organizationId: string;
  userId: string;
  accountKind: "user" | "organization";
  codeVerifier: string;
  scopeSets: string[];
  returnTo: string | null;
  createdAt: number;
  expiresAt: number;
}

/** How long a started flow waits for the provider's callback. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function strings(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((each): each is string => typeof each === "string")
      : [];
  } catch {
    return [];
  }
}

async function put(input: {
  state: string;
  providerId: string;
  organizationId: string;
  userId: string;
  accountKind: "user" | "organization";
  codeVerifier: string;
  scopeSets: readonly string[];
  returnTo: string | null;
  now?: Date;
  ttlMs?: number;
}): Promise<OAuthState> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? OAUTH_STATE_TTL_MS),
  );
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
  await db.insert(oauthStates).values({
    state: input.state,
    providerId: input.providerId,
    organizationId: input.organizationId,
    userId: input.userId,
    accountKind: input.accountKind,
    codeVerifier: input.codeVerifier,
    scopeSets: JSON.stringify([...input.scopeSets]),
    returnTo: input.returnTo,
    createdAt: now,
    expiresAt,
  });
  return {
    state: input.state,
    providerId: input.providerId,
    organizationId: input.organizationId,
    userId: input.userId,
    accountKind: input.accountKind,
    codeVerifier: input.codeVerifier,
    scopeSets: [...input.scopeSets],
    returnTo: input.returnTo,
    createdAt: now.getTime(),
    expiresAt: expiresAt.getTime(),
  };
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
  return {
    state: row.state,
    providerId: row.providerId,
    organizationId: row.organizationId,
    userId: row.userId,
    accountKind: row.accountKind === "organization" ? "organization" : "user",
    codeVerifier: row.codeVerifier,
    scopeSets: strings(row.scopeSets),
    returnTo: row.returnTo,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

/** Delete every expired row; the count. */
async function purgeExpired(now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(oauthStates)
    .where(lt(oauthStates.expiresAt, now))
    .returning({ state: oauthStates.state });
  return removed.length;
}

export const OAuthStateRepository = { put, take, purgeExpired } as const;
