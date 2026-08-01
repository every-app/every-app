import { z } from "zod";

/**
 * Editable catalog metadata for an app. Apps themselves are registered by
 * `everyapp deploy` (which owns appId, hostname, worker name, and manifest);
 * the admin UI only edits presentation and default-grant behavior.
 */
const baseAppSchema = z.object({
  name: z.string().min(1, "Name is required").max(255, "Name too long"),
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description too long"),
  isDefault: z.boolean().optional(),
});

/**
 * Schema for editing an existing app.
 */
export const editAppSchema = baseAppSchema;

/**
 * Schema for updating an app on the server (includes id).
 */
export const updateAppSchema = baseAppSchema.extend({
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

export type EditAppFormData = z.infer<typeof editAppSchema>;
