import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import type { UserOnboarding } from "@/types/onboarding";
import { getOnboardingStatus } from "@/serverFunctions/onboarding";
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
    }),
  ),
);
