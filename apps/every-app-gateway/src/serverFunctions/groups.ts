import { createServerFn } from "@tanstack/react-start";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { GroupService } from "@/server/services/GroupService";
import {
  groupActionSchema,
  groupFormSchema,
  setGroupAppsSchema,
  setGroupMembersSchema,
  updateGroupSchema,
} from "@/schemas/group";

// Groups are an owner's or admin's to manage, like app access.

/** The organization's groups, with member and app counts. */
export const listGroups = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => GroupService.listGroups(context.org));

export const createGroup = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => groupFormSchema.parse(data))
  .handler(async ({ data, context }) =>
    GroupService.createGroup(context.org, data),
  );

export const updateGroup = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => updateGroupSchema.parse(data))
  .handler(async ({ data, context }) =>
    GroupService.updateGroup(context.org, data.id, data),
  );

export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => groupActionSchema.parse(data))
  .handler(async ({ data, context }) =>
    GroupService.deleteGroup(context.org, data.id),
  );

/** Every member of the organization, flagged with whether they are in the group. */
export const getGroupMembers = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => groupActionSchema.parse(data))
  .handler(async ({ data, context }) =>
    GroupService.getGroupMembers(context.org, data.id),
  );

/** Set who is in the group (the full list). */
export const setGroupMembers = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => setGroupMembersSchema.parse(data))
  .handler(async ({ data, context }) =>
    GroupService.setGroupMembers(context.org, data.id, data.userIds),
  );

/** The organization's own apps, flagged with whether the group opens them. */
export const getGroupApps = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => groupActionSchema.parse(data))
  .handler(async ({ data, context }) =>
    GroupService.getGroupApps(context.org, data.id),
  );

/** Set which apps the group opens (the full list of app row ids). */
export const setGroupApps = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => setGroupAppsSchema.parse(data))
  .handler(async ({ data, context }) =>
    GroupService.setGroupApps(context.org, data.id, data.appRowIds),
  );
