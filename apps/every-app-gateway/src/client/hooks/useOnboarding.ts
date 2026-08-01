import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { authClient } from "@/client/auth-client";
import { userAppsCollection, onboardingCollection } from "@/client/tanstack-db";

export function useOnboarding() {
  const { data: activeMemberRole } = authClient.useActiveMemberRole();

  const { data: userApps, isLoading: isLoadingUserApps } = useLiveQuery((q) =>
    q.from({ userApp: userAppsCollection }),
  );

  const { data: onboardingData, isLoading: isLoadingOnboarding } = useLiveQuery(
    (q) => q.from({ onboarding: onboardingCollection }),
  );

  const isLoading = isLoadingUserApps || isLoadingOnboarding;

  const onboarding = onboardingData?.[0];
  const isOwner = activeMemberRole?.role === "owner";
  const hasDeployedApp = userApps && userApps.length > 0;

  // Compute derived state
  const state = useMemo(() => {
    // Deploy app (owners only)
    const showDeployStep = isOwner && !hasDeployedApp;
    const deployStepComplete = hasDeployedApp;

    const showOnboarding = showDeployStep;

    const totalSteps = isOwner ? 1 : 0;
    const completedSteps = isOwner && deployStepComplete ? 1 : 0;

    return {
      showOnboarding,
      isOwner,
      steps: {
        deployApp: {
          show: showDeployStep,
          complete: deployStepComplete ?? false,
        },
      },
      progress: {
        total: totalSteps,
        completed: completedSteps,
      },
      onboarding,
    };
  }, [activeMemberRole?.role, hasDeployedApp, isOwner, onboarding]);

  return {
    ...state,
    isLoading,
  };
}
