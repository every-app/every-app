import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { providers } from "@/db/schema";
import type { ProviderRow } from "@every-app/sdk/internal";

/**
 * The `providers` rows (server/providers/index.ts reads them into the
 * registry): every row in the order they were added, or one by id. The
 * gateway only reads here; the CLI writes the table (ADR-0003), and the
 * MCP tool, when built, writes through the same rules.
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

export const ProviderRepository = { all, byId } as const;
