import { OnboardingRepository } from "../repositories/OnboardingRepository";

/**
 * Get onboarding status for a user.
 * Creates a new record if one doesn't exist.
 */
async function getStatus(userId: string) {
  const onboarding = await OnboardingRepository.getOrCreate(userId);
  return onboarding;
}

/**
 * Update onboarding status (generic update for TanStack DB collection).
 */
async function updateStatus(
  userId: string,
  data: {
    pwaInstallCompleted?: boolean;
    pwaInstallSkipCount?: number;
    pwaInstallSkippedAt?: Date | null;
    pwaInstallSkippedPermanently?: boolean;
  },
) {
  return OnboardingRepository.update(userId, data);
}

export const OnboardingService = {
  getStatus,
  updateStatus,
} as const;
