import { z } from "zod";

/** A group's editable fields: a short name, unique in the organization. */
export const groupFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(60, "Name is at most 60 characters"),
  // Empty means none; the service stores null.
  description: z
    .string()
    .trim()
    .max(500, "Description is at most 500 characters"),
});

const groupIdSchema = z.string().regex(/^grp_[0-9a-f]{16}$/, "Invalid group");

export const updateGroupSchema = groupFormSchema.extend({ id: groupIdSchema });

export const groupActionSchema = z.object({ id: groupIdSchema });

export const setGroupMembersSchema = z.object({
  id: groupIdSchema,
  userIds: z.array(z.string().min(1, "User ID is required")),
});

export const setGroupAppsSchema = z.object({
  id: groupIdSchema,
  appRowIds: z.array(z.string().uuid("Invalid app ID")),
});

export type GroupFormData = z.infer<typeof groupFormSchema>;
