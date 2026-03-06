import { db } from "@/db";
import { members } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function hasAnyOwnerMembership(): Promise<boolean> {
  // Deliberately global across the gateway deployment.
  // Bootstrap is a one-time system initialization, not per-organization.
  const ownerMembership = await db.query.members.findFirst({
    columns: { id: true },
    where: eq(members.role, "owner"),
  });

  return Boolean(ownerMembership);
}
