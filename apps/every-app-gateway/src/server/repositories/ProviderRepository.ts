import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { providers } from "@/db/schema";
import type { ProviderRow } from "@every-app/sdk/internal";

/**
 * The `providers` rows (server/providers/index.ts reads them into the
 * registry): every row in the order they were added, or one by id. The
 * CLI writes the table under the operator's login (ADR-0003); the provider
 * tools on /mcp (server/toolbus/provider-tools.ts) write it here through
 * the same rules, never replacing a row and never touching a binding.
 */
async function all(): Promise<ProviderRow[]> {
  const rows = await db
    .select({
      id: providers.id,
      spec: providers.spec,
      addedBy: providers.addedBy,
      addedAt: providers.addedAt,
      boundTo: providers.boundTo,
    })
    .from(providers)
    .orderBy(asc(providers.addedAt), asc(providers.id));
  return rows.map((row) => ({
    id: row.id,
    spec: row.spec,
    addedBy: row.addedBy,
    addedAt: row.addedAt instanceof Date ? row.addedAt.getTime() : null,
    boundTo: row.boundTo,
  }));
}

async function byId(id: string): Promise<ProviderRow | null> {
  const [row] = await db
    .select({
      id: providers.id,
      spec: providers.spec,
      addedBy: providers.addedBy,
      addedAt: providers.addedAt,
      boundTo: providers.boundTo,
    })
    .from(providers)
    .where(eq(providers.id, id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    spec: row.spec,
    addedBy: row.addedBy,
    addedAt: row.addedAt instanceof Date ? row.addedAt.getTime() : null,
    boundTo: row.boundTo,
  };
}

/**
 * Add a row for an id that has none; false when one is there (the tool
 * never replaces a row: `providers.value-bound-to-hosts`). `spec` is the
 * spec's JSON text, `addedBy` the caller's email.
 */
async function insert(input: {
  id: string;
  spec: string;
  addedBy: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const written = await db
    .insert(providers)
    .values({
      id: input.id,
      spec: input.spec,
      addedBy: input.addedBy,
      addedAt: now,
      updatedAt: now,
      boundTo: null,
      boundAt: null,
    })
    .onConflictDoNothing()
    .returning({ id: providers.id });
  return written.length > 0;
}

/** Remove a row while it is still unbound; false when it was bound or gone meanwhile. */
async function removeUnbound(id: string): Promise<boolean> {
  const removed = await db
    .delete(providers)
    .where(and(eq(providers.id, id), isNull(providers.boundTo)))
    .returning({ id: providers.id });
  return removed.length > 0;
}

export const ProviderRepository = { all, byId, insert, removeUnbound } as const;
