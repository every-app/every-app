import { z } from "zod";

/**
 * Base schema for app catalog entries.
 */
const baseAppSchema = z.object({
  appId: z
    .string()
    .min(1, "App ID is required")
    .max(50, "App ID too long")
    .regex(
      /^[a-z0-9-]+$/,
      "App ID must contain only lowercase letters, numbers, and hyphens",
    ),
  name: z.string().min(1, "Name is required").max(255, "Name too long"),
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description too long"),
  appUrl: z.string().url("Please enter a valid URL"),
  devUrl: z.string().url("Please enter a valid URL").nullable().optional(),
  isDefault: z.boolean().optional(),
});

/**
 * Schema for creating a new app in the catalog.
 * Accepts optional pre-generated ID for optimistic updates.
 */
export const createAppSchema = baseAppSchema.extend({
  id: z.string().uuid("Invalid app ID").optional(),
  grantToAllExisting: z.boolean().optional(),
});

/**
 * Schema for editing an existing app (appId is not editable).
 */
export const editAppSchema = baseAppSchema.omit({ appId: true });

/**
 * Schema for updating an app on the server (includes id).
 */
export const updateAppSchema = baseAppSchema.omit({ appId: true }).extend({
  id: z.string().uuid("Invalid app ID"),
});

/**
 * Schema for deleting an app.
 */
export const deleteAppSchema = z.object({
  id: z.string().uuid("Invalid app ID"),
});

/**
 * Schema for managing app access.
 */
export const updateAppAccessSchema = z.object({
  appId: z.string().uuid("Invalid app ID"),
  userIds: z.array(z.string().min(1, "User ID is required")),
});

export type CreateAppFormData = z.infer<typeof createAppSchema>;
export type EditAppFormData = z.infer<typeof editAppSchema>;
