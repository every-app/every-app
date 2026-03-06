import { db } from "@/db";
import { members, users } from "@/db/schema";
import { eq } from "drizzle-orm";

async function listMembersForOrganization(organizationId: string) {
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: members.role,
      status: users.status,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.organizationId, organizationId));
}

export const OrganizationMembersRepository = {
  listMembersForOrganization,
} as const;
