import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { env } from "cloudflare:workers";

// Helper function to get the database instance from D1 binding
export const db = drizzle(env.DB, { schema });

// Export schema for use in other files
export { schema };
