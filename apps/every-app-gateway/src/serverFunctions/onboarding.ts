import { createServerFn } from "@tanstack/react-start";
import z from "zod";
import { authMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { OnboardingService } from "@/server/services/OnboardingService";

export const getOnboardingStatus = createServerFn()
  .middleware([publicErrorMiddleware, authMiddleware])
  .handler(async ({ context }) => {
    return OnboardingService.getStatus(context.user.id);
  });

const updateOnboardingSchema = z.object({
  pwaInstallCompleted: z.boolean().optional(),
  pwaInstallSkipCount: z.number().optional(),
  pwaInstallSkippedAt: z
    .union([z.string().datetime(), z.null()])
    .optional()
    .transform((val) => (val ? new Date(val) : null)),
  pwaInstallSkippedPermanently: z.boolean().optional(),
});

export const updateOnboardingStatus = createServerFn()
  .middleware([publicErrorMiddleware, authMiddleware])
  .inputValidator((data: unknown) => updateOnboardingSchema.parse(data))
  .handler(async ({ data, context }) => {
    return OnboardingService.updateStatus(context.user.id, data);
  });
