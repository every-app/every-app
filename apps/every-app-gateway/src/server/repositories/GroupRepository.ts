import { db } from "@/db";
import {
  apps,
  groupAppAccess,
  groupMembers,
  groups,
  members,
  users,
} from "@/db/schema";
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import {
  and,
  asc,
  countDistinct,
  eq,
  inArray,
  isNotNull,
  ne,
  sql,
} from "drizzle-orm";

// D1 binds at most 100 parameters per statement: group_members and
// group_app_access have 5 columns each, and a delete lists ids.
const ROWS_PER_INSERT = 19;
const IDS_PER_DELETE = 90;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

/** The organization's groups, with how many members and apps each has. */
async function listByOrganization(organizationId: string) {
  return db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      createdAt: groups.createdAt,
      memberCount: countDistinct(groupMembers.userId),
      appCount: countDistinct(apps.id),
    })
    .from(groups)
    .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .leftJoin(groupAppAccess, eq(groupAppAccess.groupId, groups.id))
    .leftJoin(
      apps,
      and(
        eq(apps.id, groupAppAccess.appRowId),
        ne(apps.status, DELETED_APP_STATUS),
      ),
    )
    .where(eq(groups.organizationId, organizationId))
    .groupBy(groups.id)
    .orderBy(asc(groups.name));
}

async function findById(id: string, organizationId: string) {
  return db.query.groups.findFirst({
    where: and(eq(groups.id, id), eq(groups.organizationId, organizationId)),
  });
}

/** A group of the organization by name, letter case aside; `exceptId` skips one. */
async function findByName(
  organizationId: string,
  name: string,
  exceptId?: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(
      and(
        eq(groups.organizationId, organizationId),
        eq(sql`lower(${groups.name})`, name.toLowerCase()),
        ...(exceptId ? [ne(groups.id, exceptId)] : []),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function create(data: {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  createdBy: string | null;
}) {
  await db.insert(groups).values(data);
}

async function update(
  id: string,
  organizationId: string,
  data: { name: string; description: string | null },
) {
  await db
    .update(groups)
    .set(data)
    .where(and(eq(groups.id, id), eq(groups.organizationId, organizationId)));
}

async function remove(id: string, organizationId: string) {
  await db
    .delete(groups)
    .where(and(eq(groups.id, id), eq(groups.organizationId, organizationId)));
}

/** Every member of the organization, and whether they are in the group. */
async function listMembersWithState(groupId: string, organizationId: string) {
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: members.role,
      status: users.status,
      banned: users.banned,
      inGroup: isNotNull(groupMembers.userId).mapWith(Boolean),
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .leftJoin(
      groupMembers,
      and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, users.id)),
    )
    .where(eq(members.organizationId, organizationId))
    .orderBy(asc(users.name), asc(users.email));
}

/** The user ids in a group. */
async function listMemberIds(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId));
  return rows.map((row) => row.userId);
}

/** Put `add` into the group and take `remove` out, in one D1 transaction. */
async function changeMembers(input: {
  groupId: string;
  organizationId: string;
  add: string[];
  remove: string[];
  addedBy: string;
}) {
  const statements = [
    ...chunks(input.remove, IDS_PER_DELETE).map((ids) =>
      db
        .delete(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, input.groupId),
            inArray(groupMembers.userId, ids),
          ),
        ),
    ),
    ...chunks(input.add, ROWS_PER_INSERT).map((ids) =>
      db
        .insert(groupMembers)
        .values(
          ids.map((userId) => ({
            groupId: input.groupId,
            userId,
            organizationId: input.organizationId,
            addedBy: input.addedBy,
          })),
        )
        .onConflictDoNothing(),
    ),
  ];
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

/**
 * The organization's own apps a group could be granted (not shared, not
 * deleted), and whether it is.
 */
async function listAppsWithState(groupId: string, organizationId: string) {
  return db
    .select({
      id: apps.id,
      appId: apps.appSlug,
      name: apps.name,
      description: apps.description,
      status: apps.status,
      granted: isNotNull(groupAppAccess.groupId).mapWith(Boolean),
    })
    .from(apps)
    .leftJoin(
      groupAppAccess,
      and(
        eq(groupAppAccess.groupId, groupId),
        eq(groupAppAccess.appRowId, apps.id),
      ),
    )
    .where(
      and(
        eq(apps.organizationId, organizationId),
        ne(apps.scope, "shared"),
        ne(apps.status, DELETED_APP_STATUS),
      ),
    )
    .orderBy(asc(apps.name));
}

/** The app row ids a group is granted. */
async function listAppRowIds(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ appRowId: groupAppAccess.appRowId })
    .from(groupAppAccess)
    .where(eq(groupAppAccess.groupId, groupId));
  return rows.map((row) => row.appRowId);
}

/** Grant `add` to the group and revoke `remove`, in one D1 transaction. */
async function changeApps(input: {
  groupId: string;
  organizationId: string;
  add: string[];
  remove: string[];
  grantedBy: string;
}) {
  const statements = [
    ...chunks(input.remove, IDS_PER_DELETE).map((ids) =>
      db
        .delete(groupAppAccess)
        .where(
          and(
            eq(groupAppAccess.groupId, input.groupId),
            inArray(groupAppAccess.appRowId, ids),
          ),
        ),
    ),
    ...chunks(input.add, ROWS_PER_INSERT).map((ids) =>
      db
        .insert(groupAppAccess)
        .values(
          ids.map((appRowId) => ({
            groupId: input.groupId,
            appRowId,
            organizationId: input.organizationId,
            grantedBy: input.grantedBy,
          })),
        )
        .onConflictDoNothing(),
    ),
  ];
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

export const GroupRepository = {
  listByOrganization,
  findById,
  findByName,
  create,
  update,
  remove,
  listMembersWithState,
  listMemberIds,
  changeMembers,
  listAppsWithState,
  listAppRowIds,
  changeApps,
} as const;
