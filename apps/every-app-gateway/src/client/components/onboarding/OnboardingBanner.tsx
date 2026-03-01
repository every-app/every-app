import { useState, useMemo } from "react";
import { useOnboarding } from "@/client/hooks/useOnboarding";
import { DeployAppStep } from "./DeployAppStep";
import { MobileAppStep } from "./MobileAppStep";

export function OnboardingBanner() {
  const { showOnboarding, steps, progress, isLoading } = useOnboarding();

  // Compute the default expanded step based on current state
  const defaultExpandedStep = useMemo((): "deploy" | "mobile" | null => {
    if (steps.deployApp.show && !steps.deployApp.complete) return "deploy";
    return "mobile";
  }, [steps.deployApp.show, steps.deployApp.complete]);

  // Track user's manual expansion choice (null means use default)
  const [userExpandedStep, setUserExpandedStep] = useState<
    "deploy" | "mobile" | null | "none"
  >(null);

  // Use user's choice if set, otherwise use default
  const expandedStep =
    userExpandedStep === "none"
      ? null
      : (userExpandedStep ?? defaultExpandedStep);

  // Don't render anything while loading to prevent flickering
  if (isLoading || !showOnboarding) {
    return null;
  }

  const toggleStep = (step: "deploy" | "mobile") => {
    setUserExpandedStep((current) => {
      const effectiveCurrent =
        current === "none" ? null : (current ?? defaultExpandedStep);
      return effectiveCurrent === step ? "none" : step;
    });
  };

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
        {steps.deployApp.show && (
          <DeployAppStep
            isExpanded={expandedStep === "deploy"}
            onToggle={() => toggleStep("deploy")}
          />
        )}

        <MobileAppStep
          isExpanded={expandedStep === "mobile"}
          onToggle={() => toggleStep("mobile")}
        />
      </div>
    </div>
  );
}
