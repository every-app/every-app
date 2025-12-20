import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import type { UserOnboarding } from "@/types/onboarding";
import {
  getOnboardingStatus,
  updateOnboardingStatus,
} from "@/serverFunctions/onboarding";
import { lazyInitForWorkers } from "@/utils/lazyInitForWorkers";

export const onboardingCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["onboarding"],
      queryFn: async () => {
        const result = await getOnboardingStatus();
        // Return as array with single item for collection semantics
        return result ? [result] : [];
      },
      queryClient,
      getKey: (item: UserOnboarding) => item.id,

      // Handle update operations
      onUpdate: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) => {
            const modified = mutation.modified;
            return updateOnboardingStatus({
              data: {
                pwaInstallCompleted: modified.pwaInstallCompleted,
                pwaInstallSkipCount: modified.pwaInstallSkipCount,
                pwaInstallSkippedAt: modified.pwaInstallSkippedAt
                  ? modified.pwaInstallSkippedAt.toISOString()
                  : null,
                pwaInstallSkippedPermanently:
                  modified.pwaInstallSkippedPermanently,
              },
            });
          }),
        );
      },
    }),
  ),
);
