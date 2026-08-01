import { OnboardingRepository } from "../repositories/OnboardingRepository";

/**
 * Get onboarding status for a user.
 * Creates a new record if one doesn't exist.
 */
async function getStatus(userId: string) {
  const onboarding = await OnboardingRepository.getOrCreate(userId);
  return onboarding;
}

export const OnboardingService = {
  getStatus,
} as const;
