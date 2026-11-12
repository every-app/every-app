import { sql } from "drizzle-orm";
import { apps } from "@/db/schema";

/**
 * The launcher icon's path the app's manifest names (`icon`), or null.
 * Built per query rather than on import, so a module that only imports a
 * repository doesn't evaluate SQL.
 */
export function manifestIcon() {
  return sql<string | null>`json_extract(${apps.manifest}, '$.icon')`;
}
