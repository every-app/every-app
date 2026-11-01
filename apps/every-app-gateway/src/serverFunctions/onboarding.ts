import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { OnboardingService } from "@/server/services/OnboardingService";

export const getOnboardingStatus = createServerFn()
  .middleware([publicErrorMiddleware, authMiddleware])
  .handler(async ({ context }) => {
    return OnboardingService.getStatus(context.user.id);
  });
