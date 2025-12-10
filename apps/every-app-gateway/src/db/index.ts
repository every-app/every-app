import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { env } from "cloudflare:workers";
import { lazyInitForWorkers } from "@/utils/lazyInitForWorkers";

/**
 * Lazy-initialized database instance.
 * Defers initialization until first access to ensure cloudflare:workers env is available.
 */
export const db = lazyInitForWorkers(() => drizzle(env.DB, { schema }));

export { schema };
