import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useRef } from "react";
import { useSession } from "./useSession";
import { userAppsCollection, onboardingCollection } from "@/client/tanstack-db";
import { isPWAStandalone } from "@/utils/platform";

// Onboarding configuration constants
const MAX_TEMPORARY_SKIPS = 3;
const SKIP_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check if the skip cooldown is still active (user recently skipped).
 * Returns true if the user skipped within the cooldown period.
 */
function isSkipCooldownActive(date: Date | string | number | null): boolean {
  if (!date) return false;
  const timestamp =
    date instanceof Date ? date.getTime() : new Date(date).getTime();
  return Date.now() - timestamp < SKIP_COOLDOWN_MS;
}

export function useOnboarding() {
  const { data: session } = useSession();

  const { data: userApps, isLoading: isLoadingUserApps } = useLiveQuery((q) =>
    q.from({ userApp: userAppsCollection }),
  );

  const { data: onboardingData, isLoading: isLoadingOnboarding } = useLiveQuery(
    (q) => q.from({ onboarding: onboardingCollection }),
  );

  const isLoading = isLoadingUserApps || isLoadingOnboarding;

  const onboarding = onboardingData?.[0];
  const isOwner = session?.user?.role === "owner";
  const hasDeployedApp = userApps && userApps.length > 0;
  const isPWAInstalled = isPWAStandalone();

  // Track if we've already attempted auto-complete to prevent duplicate updates
  const hasAutoCompletedRef = useRef(false);

  // Auto-complete PWA step if detected as running in PWA mode
  useEffect(() => {
    const onboardingId = onboarding?.id;
    const pwaInstallCompleted = onboarding?.pwaInstallCompleted;

    if (
      isPWAInstalled &&
      onboardingId &&
      !pwaInstallCompleted &&
      !hasAutoCompletedRef.current
    ) {
      hasAutoCompletedRef.current = true;
      onboardingCollection.update(onboardingId, (draft) => {
        draft.pwaInstallCompleted = true;
        draft.updatedAt = new Date();
      });
    }
  }, [isPWAInstalled, onboarding?.id, onboarding?.pwaInstallCompleted]);

  // Compute derived state
  const state = useMemo(() => {
    // Step 1: Deploy app (owners only)
    const showDeployStep = isOwner && !hasDeployedApp;
    const deployStepComplete = hasDeployedApp;

    // Step 2: PWA install (disabled from onboarding for now - can still be accessed via /?pwa=true)
    const pwaCompleted = onboarding?.pwaInstallCompleted ?? false;
    const pwaSkippedPermanently =
      onboarding?.pwaInstallSkippedPermanently ?? false;
    const pwaSkipCount = onboarding?.pwaInstallSkipCount ?? 0;
    const pwaSkippedAt = onboarding?.pwaInstallSkippedAt ?? null;

    // PWA step is disabled from onboarding flow (set to false to hide it)
    // Users can still access PWA install via /?pwa=true or /pwa route
    const shouldShowPWAStep = false;

    // Should show "Skip permanently" option (on last temporary skip)
    const showSkipPermanently = pwaSkipCount >= MAX_TEMPORARY_SKIPS - 1;

    // Show banner if any step needs to be shown
    const showOnboarding = showDeployStep;

    // Calculate progress (only counting deploy step now since PWA is disabled)
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
        pwaInstall: {
          show: shouldShowPWAStep,
          complete: pwaCompleted,
          skipCount: pwaSkipCount,
          showSkipPermanently,
        },
      },
      progress: {
        total: totalSteps,
        completed: completedSteps,
      },
      onboarding,
    };
  }, [isOwner, hasDeployedApp, onboarding]);

  // Actions
  const completePWAInstall = () => {
    if (!onboarding) return;
    onboardingCollection.update(onboarding.id, (draft) => {
      draft.pwaInstallCompleted = true;
      draft.updatedAt = new Date();
    });
  };

  const skipPWAInstall = () => {
    if (!onboarding) return;
    onboardingCollection.update(onboarding.id, (draft) => {
      draft.pwaInstallSkipCount = (draft.pwaInstallSkipCount ?? 0) + 1;
      draft.pwaInstallSkippedAt = new Date();
      draft.updatedAt = new Date();
    });
  };

  const skipPWAInstallPermanently = () => {
    if (!onboarding) return;
    onboardingCollection.update(onboarding.id, (draft) => {
      draft.pwaInstallSkippedPermanently = true;
      draft.updatedAt = new Date();
    });
  };

  return {
    ...state,
    isLoading,
    actions: {
      completePWAInstall,
      skipPWAInstall,
      skipPWAInstallPermanently,
    },
  };
}
