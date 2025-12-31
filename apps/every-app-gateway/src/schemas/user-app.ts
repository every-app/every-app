import { z } from "zod";

/**
 * Default URL for local development servers.
 */
export const DEFAULT_DEV_URL = "http://localhost:3001";

/**
 * Base schema for user app with all fields.
 * Other schemas are derived from this using .omit() and .extend().
 */
const baseUserAppSchema = z.object({
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
});

/**
 * Schema for creating a new user app.
 */
export const createUserAppSchema = baseUserAppSchema;

/**
 * Schema for editing an existing user app (appId is not editable).
 */
export const editUserAppSchema = baseUserAppSchema.omit({ appId: true });

/**
 * Schema for updating a user app on the server (includes id instead of appId).
 */
export const updateUserAppSchema = baseUserAppSchema
  .omit({ appId: true })
  .extend({
    id: z.string().uuid("Invalid app ID"),
  });

/**
 * Schema for deleting a user app.
 */
export const deleteUserAppSchema = z.object({
  id: z.string().uuid("Invalid app ID"),
});

export type CreateUserAppFormData = z.infer<typeof createUserAppSchema>;
export type EditUserAppFormData = z.infer<typeof editUserAppSchema>;
