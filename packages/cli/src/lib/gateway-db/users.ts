import { queryD1Database } from "@/lib/cloudflare-d1-queries";
import type { GatewayDbConnection } from "./connection";

/**
 * A user from the gateway database
 */
export interface User {
  id: string;
  name: string;
  email: string;
  role: string | null;
}

/**
 * Get all users from the gateway database
 */
export async function getAllUsers(db: GatewayDbConnection): Promise<User[]> {
  return queryD1Database<User>(
    db.accountId,
    db.databaseId,
    "SELECT id, name, email, role FROM users",
  );
}
