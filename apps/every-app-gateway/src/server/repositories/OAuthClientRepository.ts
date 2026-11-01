import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { oauthClients } from "@/db/schema";
import { open, seal, type SealingEnv } from "@/server/secrets/sealed";

/**
 * The OAuth clients uploaded in the UI (docs/design/2026-10-oauth-providers.md
 * section 6): one per provider, gateway-wide. The secret is sealed on the
 * way in and opened on the way out; nothing here returns the ciphertext.
 * A client is read only when the Worker env lacks the provider's own
 * `clientId` setting (the flow decides that, not this repository).
 */
interface StoredOAuthClient {
  providerId: string;
  clientId: string;
  /** Whether a secret is held (a public client has none). */
  hasSecret: boolean;
  boundTo: string | null;
  addedBy: string | null;
  addedAt: number;
  updatedAt: number;
}

const columns = {
  providerId: oauthClients.providerId,
  clientId: oauthClients.clientId,
  clientSecretEnc: oauthClients.clientSecretEnc,
  boundTo: oauthClients.boundTo,
  addedBy: oauthClients.addedBy,
  addedAt: oauthClients.addedAt,
  updatedAt: oauthClients.updatedAt,
};

type Row = {
  providerId: string;
  clientId: string;
  clientSecretEnc: string | null;
  boundTo: string | null;
  addedBy: string | null;
  addedAt: Date;
  updatedAt: Date;
};

function shape(row: Row): StoredOAuthClient {
  return {
    providerId: row.providerId,
    clientId: row.clientId,
    hasSecret: row.clientSecretEnc !== null,
    boundTo: row.boundTo,
    addedBy: row.addedBy,
    addedAt: row.addedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

async function get(providerId: string): Promise<StoredOAuthClient | null> {
  const [row] = await db
    .select(columns)
    .from(oauthClients)
    .where(eq(oauthClients.providerId, providerId))
    .limit(1);
  return row ? shape(row) : null;
}

async function all(): Promise<StoredOAuthClient[]> {
  const rows = await db
    .select(columns)
    .from(oauthClients)
    .orderBy(asc(oauthClients.addedAt), asc(oauthClients.providerId));
  return rows.map(shape);
}

/**
 * The client id and the opened secret, for the flow. `secret` is null for
 * a public client; `lost: true` when a secret is held but does not open
 * (the sealing secret changed), so the caller asks for it again.
 */
async function credentials(
  providerId: string,
  env: SealingEnv,
): Promise<{
  clientId: string;
  secret: string | null;
  boundTo: string | null;
  lost: boolean;
} | null> {
  const [row] = await db
    .select(columns)
    .from(oauthClients)
    .where(eq(oauthClients.providerId, providerId))
    .limit(1);
  if (!row) return null;
  if (row.clientSecretEnc === null) {
    return {
      clientId: row.clientId,
      secret: null,
      boundTo: row.boundTo,
      lost: false,
    };
  }
  const secret = await open(row.clientSecretEnc, env);
  return {
    clientId: row.clientId,
    secret,
    boundTo: row.boundTo,
    lost: secret === null,
  };
}

/**
 * Write or replace the client for a provider: the secret sealed, `boundTo`
 * the provider's binding key as it is now, `addedBy` kept from the first
 * upload when replacing.
 */
async function upsert(
  input: {
    providerId: string;
    clientId: string;
    clientSecret: string | null;
    boundTo: string;
    addedBy: string;
    now?: Date;
  },
  env: SealingEnv,
): Promise<StoredOAuthClient> {
  const now = input.now ?? new Date();
  const clientSecretEnc =
    input.clientSecret === null ? null : await seal(input.clientSecret, env);
  const [row] = await db
    .insert(oauthClients)
    .values({
      providerId: input.providerId,
      clientId: input.clientId,
      clientSecretEnc,
      boundTo: input.boundTo,
      addedBy: input.addedBy,
      addedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: oauthClients.providerId,
      set: {
        clientId: input.clientId,
        clientSecretEnc,
        boundTo: input.boundTo,
        updatedAt: now,
      },
    })
    .returning(columns);
  return shape(row!);
}

/** Remove a provider's client; false when none was held. */
async function remove(providerId: string): Promise<boolean> {
  const removed = await db
    .delete(oauthClients)
    .where(eq(oauthClients.providerId, providerId))
    .returning({ providerId: oauthClients.providerId });
  return removed.length > 0;
}

export const OAuthClientRepository = {
  get,
  all,
  credentials,
  upsert,
  remove,
} as const;
