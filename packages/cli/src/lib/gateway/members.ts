/**
 * The members of the install's workspace, as the CLI reads and writes them
 * in the Gateway's D1 under the Cloudflare login (`workspace role`). The
 * rule is the Gateway's own (MembershipService there): an organization
 * always keeps at least one owner who can act, so one conditional UPDATE
 * sets a role and refuses to demote an owner while no other owner is
 * live, in the same statement that looks for one. Live is the Gateway's
 * `liveUser` (OrganizationMembersRepository): not banned, or banned with
 * an expiry already past. A deactivated owner doesn't count, so this
 * command can't leave a workspace whose only owner is locked out.
 */
import type { D1Database } from "@/lib/cf/d1";

type MemberRole = "owner" | "admin" | "member";

interface WorkspaceMember {
  id: string;
  email: string;
  name: string;
  role: string;
}

type SetMemberRoleResult =
  | { kind: "changed"; member: WorkspaceMember; previousRole: string }
  | { kind: "unchanged"; member: WorkspaceMember }
  | { kind: "last_owner"; member: WorkspaceMember }
  | { kind: "not_found" };

const MEMBER_BY_EMAIL = `SELECT users.id AS id, users.email AS email, users.name AS name, members.role AS role
FROM members JOIN users ON users.id = members.user_id
WHERE members.organization_id = ?1 AND lower(users.email) = ?2
LIMIT 1`;

/**
 * SQL: an owner of organization `organization` who can act exists besides
 * user `user`, at `now` (milliseconds): the last-owner rule as the write
 * holds it (the Gateway's `wouldLeaveNoLiveOwner`, negated). The three
 * are SQL expressions: a `?n` parameter, or a column of the statement
 * around it. `workspace role` demotes, `workspace deactivate` bans and
 * `workspace remove` deletes only while this holds for the owner acted on.
 */
export const anotherLiveOwnerSql = (organization: string, user: string, now: string): string =>
  `EXISTS (
      SELECT 1 FROM members owners JOIN users owner ON owner.id = owners.user_id
      WHERE owners.organization_id = ${organization} AND owners.role = 'owner' AND owners.user_id <> ${user}
        AND (owner.banned IS NULL OR owner.banned = 0 OR (owner.ban_expires IS NOT NULL AND owner.ban_expires <= ${now}))
    )`;

/**
 * Set a member's role by email (matched without case), in one D1 batch:
 * the row before, the guarded UPDATE, the row after. The UPDATE changes
 * nothing when the member isn't one, already has the role, or is an owner
 * no other live owner would outlast and would stop being one; the rows
 * around it say which.
 */
export async function setMemberRole(
  db: D1Database,
  organizationId: string,
  email: string,
  role: MemberRole,
): Promise<SetMemberRoleResult> {
  const address = email.trim().toLowerCase();
  const nowMs = Date.now();
  const [before = [], , after = []] = await db.run([
    { sql: MEMBER_BY_EMAIL, params: [organizationId, address] },
    {
      sql: `UPDATE members SET role = ?3
WHERE organization_id = ?1
  AND user_id = (SELECT id FROM users WHERE lower(email) = ?2 LIMIT 1)
  AND role <> ?3
  AND NOT (
    role = 'owner' AND ?3 <> 'owner'
    AND NOT ${anotherLiveOwnerSql("?1", "members.user_id", "?4")}
  )`,
      params: [organizationId, address, role, nowMs],
    },
    { sql: MEMBER_BY_EMAIL, params: [organizationId, address] },
  ]);
  const was = toMember(before[0]);
  if (!was) return { kind: "not_found" };
  if (was.role === role) return { kind: "unchanged", member: was };
  const now = toMember(after[0]) ?? was;
  if (now.role === role) return { kind: "changed", member: now, previousRole: was.role };
  return { kind: "last_owner", member: was };
}

function toMember(row: Record<string, unknown> | undefined): WorkspaceMember | null {
  if (!row) return null;
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    name: String(row["name"] ?? ""),
    role: String(row["role"]),
  };
}
