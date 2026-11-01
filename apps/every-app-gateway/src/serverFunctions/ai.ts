import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import {
  AiDefaultService,
  type AiDefaultReport,
} from "@/server/services/AiDefaultService";

/**
 * What the active organization's default model provider resolves to now
 * (Manage workspace → Usage → AI default): the provider, model, source,
 * whether it is configured, whether AI Gateway is in front, and every
 * candidate in order. Owners and admins only.
 */
export const getAiDefault = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }): Promise<AiDefaultReport> => {
    return AiDefaultService.get(context.org);
  });

const setAiDefaultSchema = z
  .object({
    /** The provider's id; null clears the choice (the shipped order decides). */
    provider: z.string().trim().min(2).max(40).nullable(),
    /** The model to fill in when an app names none; omitted, the provider's own. */
    model: z.string().trim().min(1).max(200).optional(),
  })
  .refine((data) => data.provider !== null || data.model === undefined, {
    message: "A model needs a provider",
    path: ["model"],
  });

/** Set or clear the active organization's default model provider. Owners and admins only. */
export const setAiDefault = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => setAiDefaultSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AiDefaultService.set(context.org, {
      choice:
        data.provider === null
          ? null
          : {
              provider: data.provider,
              ...(data.model ? { model: data.model } : {}),
            },
    });
  });
