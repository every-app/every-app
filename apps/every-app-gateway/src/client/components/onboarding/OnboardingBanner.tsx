import { useState } from "react";
import { useOnboarding } from "@/client/hooks/useOnboarding";
import { DeployAppStep } from "./DeployAppStep";

export function OnboardingBanner() {
  const { showOnboarding, steps, progress, isLoading } = useOnboarding();

  // Track user's manual expansion choice (null means use default: expanded
  // while the deploy step is incomplete)
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const isExpanded =
    userCollapsed === null ? !steps.deployApp.complete : !userCollapsed;

  // Don't render anything while loading to prevent flickering
  if (isLoading || !showOnboarding || !steps.deployApp.show) {
    return null;
  }

  return (
    <div className="bg-gradient-to-r from-primary/10 to-secondary/10 border border-primary/20 rounded-xl p-4 sm:p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-1">
          <h2 className="font-bold text-lg">Get started with Every App</h2>
        </div>
        {progress.total > 0 && (
          <div className="text-sm font-medium text-primary">
            {progress.completed}/{progress.total}
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="space-y-3">
        <DeployAppStep
          isExpanded={isExpanded}
          onToggle={() => setUserCollapsed(isExpanded)}
        />
      </div>
    </div>
  );
}
