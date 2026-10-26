import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { providerScopeSets } from "@/db/schema";
import type { ScopeSetRow } from "@every-app/sdk/internal";

/**
 * The `provider_scope_sets` rows (server/providers/index.ts reads them
 * into the registry, where each is checked against its client's catalog
 * entry): every row in the order they were added. The CLI writes the
 * table under the operator's login (ADR-0003); Admin → Providers and the
 * `everyapp_provider_scope_set_*` tools write it here through the same
 * rules. A row is never replaced here: `everyapp provider scope-set add
 * --replace` is the terminal's.
 */
async function all(): Promise<ScopeSetRow[]> {
  const rows = await db
    .select({
      providerId: providerScopeSets.providerId,
      name: providerScopeSets.name,
      spec: providerScopeSets.spec,
      addedBy: providerScopeSets.addedBy,
      addedAt: providerScopeSets.addedAt,
    })
    .from(providerScopeSets)
    .orderBy(
      asc(providerScopeSets.addedAt),
      asc(providerScopeSets.providerId),
      asc(providerScopeSets.name),
    );
  return rows.map((row) => ({
    providerId: row.providerId,
    name: row.name,
    spec: row.spec,
    addedBy: row.addedBy,
    addedAt: row.addedAt instanceof Date ? row.addedAt.getTime() : null,
  }));
}

/** Add a row for a client and name that have none; false when one is there. */
async function insert(input: {
  providerId: string;
  name: string;
  spec: string;
  addedBy: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const written = await db
    .insert(providerScopeSets)
    .values({
      providerId: input.providerId,
      name: input.name,
      spec: input.spec,
      addedBy: input.addedBy,
      addedAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ name: providerScopeSets.name });
  return written.length > 0;
}

/** Remove a row; false when it was gone already. */
async function remove(providerId: string, name: string): Promise<boolean> {
  const removed = await db
    .delete(providerScopeSets)
    .where(
      and(
        eq(providerScopeSets.providerId, providerId),
        eq(providerScopeSets.name, name),
      ),
    )
    .returning({ name: providerScopeSets.name });
  return removed.length > 0;
}

export const ScopeSetRepository = { all, insert, remove } as const;
