import { MAX_ORGANIZATION_NAME_LENGTH } from "@every-app/sdk/internal";
import { z } from "zod";

/**
 * The Rename dialog's one field. The form checks the length the person
 * sees; the service applies the whole rule (`validOrganizationName`:
 * collapsed whitespace, no control characters) and answers
 * INVALID_ORGANIZATION_NAME.
 */
export const workspaceNameFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(
      MAX_ORGANIZATION_NAME_LENGTH,
      `Name is at most ${MAX_ORGANIZATION_NAME_LENGTH} characters`,
    ),
});

/** What the server function takes: a string the rule trims and bounds. */
export const renameOrganizationSchema = z.object({
  name: z.string().max(256),
});

export type WorkspaceNameFormData = z.infer<typeof workspaceNameFormSchema>;
