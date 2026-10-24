import { logEvent } from "@every-app/perimeter";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import { AppRepository } from "../repositories/AppRepository";
import { GroupRepository } from "../repositories/GroupRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";

type GroupInput = { name: string; description?: string | null };

/** "grp_" + 16 hex. */
function newGroupId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `grp_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function normalize(input: GroupInput) {
  const name = input.name.trim();
  const description = input.description?.trim() || null;
  if (name.length < 1 || name.length > 60) {
    throw new PublicError(
      "INVALID_INPUT",
      "A group name is 1 to 60 characters",
    );
  }
  return { name, description };
}

/**
 * The database's answer to a duplicate name: `groups_organization_name_unique`
 * is on `lower(name)`, so two admins creating "Sales" and "sales" at once
 * (two isolates, both past {@link assertNameFree}) lose one insert here.
 */
function isNameConflict(error: unknown): boolean {
  const messages = [error, error instanceof Error ? error.cause : null].map(
    (part) => (part instanceof Error ? part.message : ""),
  );
  return messages.some((message) =>
    /UNIQUE constraint failed:.*groups/i.test(message),
  );
}

async function refusingNameConflict<T>(
  name: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isNameConflict(error)) {
      throw new PublicError(
        "GROUP_NAME_TAKEN",
        `A group named "${name}" already exists`,
      );
    }
    throw error;
  }
}

/** Group names are unique in an organization, letter case aside. */
async function assertNameFree(
  organizationId: string,
  name: string,
  exceptId?: string,
) {
  const taken = await GroupRepository.findByName(
    organizationId,
    name,
    exceptId,
  );
  if (taken) {
    throw new PublicError(
      "GROUP_NAME_TAKEN",
      `A group named "${taken.name}" already exists`,
    );
  }
}

async function requireGroup(ctx: OrgContext, groupId: string) {
  const group = await GroupRepository.findById(groupId, ctx.orgId);
  if (!group) throw new PublicError("GROUP_NOT_FOUND", "Group not found");
  return group;
}

/** The organization's groups, with member and app counts. */
async function listGroups(ctx: OrgContext) {
  return { groups: await GroupRepository.listByOrganization(ctx.orgId) };
}

async function createGroup(ctx: OrgContext, input: GroupInput) {
  const { name, description } = normalize(input);
  await assertNameFree(ctx.orgId, name);
  const id = newGroupId();
  await refusingNameConflict(name, () =>
    GroupRepository.create({
      id,
      organizationId: ctx.orgId,
      name,
      description,
      createdBy: ctx.userId,
    }),
  );
  logEvent("group.created", {
    organizationId: ctx.orgId,
    groupId: id,
    by: ctx.userId,
  });
  return { id, name, description };
}

async function updateGroup(
  ctx: OrgContext,
  groupId: string,
  input: GroupInput,
) {
  await requireGroup(ctx, groupId);
  const { name, description } = normalize(input);
  await assertNameFree(ctx.orgId, name, groupId);
  await refusingNameConflict(name, () =>
    GroupRepository.update(groupId, ctx.orgId, { name, description }),
  );
  return { id: groupId, name, description };
}

/** Deleting a group ends what it granted: its members and apps go with it. */
async function deleteGroup(ctx: OrgContext, groupId: string) {
  await requireGroup(ctx, groupId);
  await GroupRepository.remove(groupId, ctx.orgId);
  logEvent("group.deleted", {
    organizationId: ctx.orgId,
    groupId,
    by: ctx.userId,
  });
  return { success: true };
}

/** Every member of the organization, flagged with whether they are in the group. */
async function getGroupMembers(ctx: OrgContext, groupId: string) {
  await requireGroup(ctx, groupId);
  const users = await GroupRepository.listMembersWithState(groupId, ctx.orgId);
  return { users };
}

/**
 * Set who is in a group, as a full list. Only members of the organization
 * can be in its groups: any other id is refused, so a group never holds
 * someone from another organization. (A deactivated member may stay
 * listed; the perimeter refuses them anyway.)
 */
async function setGroupMembers(
  ctx: OrgContext,
  groupId: string,
  userIds: string[],
) {
  await requireGroup(ctx, groupId);
  const organizationUsers =
    await OrganizationMembersRepository.listMembersForOrganization(ctx.orgId);
  const memberIds = new Set(organizationUsers.map((user) => user.id));
  const wanted = new Set(userIds);
  for (const userId of wanted) {
    if (!memberIds.has(userId)) {
      throw new PublicError(
        "USER_NOT_FOUND",
        "Only members of this organization can be in its groups",
      );
    }
  }
  const current = new Set(await GroupRepository.listMemberIds(groupId));
  const add = [...wanted].filter((id) => !current.has(id));
  const remove = [...current].filter((id) => !wanted.has(id));
  await GroupRepository.changeMembers({
    groupId,
    organizationId: ctx.orgId,
    add,
    remove,
    addedBy: ctx.userId,
  });
  logEvent("group.members_changed", {
    organizationId: ctx.orgId,
    groupId,
    added: add.length,
    removed: remove.length,
    by: ctx.userId,
  });
  return { added: add.length, removed: remove.length };
}

/** The organization's own apps, flagged with whether the group opens them. */
async function getGroupApps(ctx: OrgContext, groupId: string) {
  await requireGroup(ctx, groupId);
  const apps = await GroupRepository.listAppsWithState(groupId, ctx.orgId);
  return { apps };
}

/**
 * Set which apps a group opens, as a full list of app row ids. Only the
 * organization's own apps: a shared app is everyone's already
 * (SHARED_APP_ACCESS), and another organization's is not found.
 */
async function setGroupApps(
  ctx: OrgContext,
  groupId: string,
  appRowIds: string[],
) {
  await requireGroup(ctx, groupId);
  const wanted = new Set(appRowIds);
  for (const appRowId of wanted) {
    const app = await AppRepository.findById(appRowId, ctx.orgId);
    if (!app) throw new PublicError("APP_NOT_FOUND", "App not found");
    if (app.scope === "shared") {
      throw new PublicError(
        "SHARED_APP_ACCESS",
        "Every member of every organization can open a shared app; it can't be granted to a group.",
      );
    }
  }
  const current = new Set(await GroupRepository.listAppRowIds(groupId));
  const add = [...wanted].filter((id) => !current.has(id));
  const remove = [...current].filter((id) => !wanted.has(id));
  await GroupRepository.changeApps({
    groupId,
    organizationId: ctx.orgId,
    add,
    remove,
    grantedBy: ctx.userId,
  });
  logEvent("group.apps_changed", {
    organizationId: ctx.orgId,
    groupId,
    granted: add.length,
    revoked: remove.length,
    by: ctx.userId,
  });
  return { granted: add.length, revoked: remove.length };
}

export const GroupService = {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupMembers,
  setGroupMembers,
  getGroupApps,
  setGroupApps,
} as const;
