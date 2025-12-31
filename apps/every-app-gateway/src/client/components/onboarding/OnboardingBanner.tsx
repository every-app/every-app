import { useState, useMemo } from "react";
import { useOnboarding } from "@/client/hooks/useOnboarding";
import { DeployAppStep } from "./DeployAppStep";
import { PWAInstallStep } from "./PWAInstallStep";

export function OnboardingBanner() {
  const { showOnboarding, steps, progress, actions, isLoading } =
    useOnboarding();

  // Compute the default expanded step based on current state
  const defaultExpandedStep = useMemo((): "deploy" | "pwa" | null => {
    if (steps.deployApp.show && !steps.deployApp.complete) return "deploy";
    if (steps.pwaInstall.show && !steps.pwaInstall.complete) return "pwa";
    return null;
  }, [
    steps.deployApp.show,
    steps.deployApp.complete,
    steps.pwaInstall.show,
    steps.pwaInstall.complete,
  ]);

  // Track user's manual expansion choice (null means use default)
  const [userExpandedStep, setUserExpandedStep] = useState<
    "deploy" | "pwa" | null | "none"
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

  const toggleStep = (step: "deploy" | "pwa") => {
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
        <div className="text-sm font-medium text-primary">
          {progress.completed}/{progress.total}
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {steps.deployApp.show && (
          <DeployAppStep
            isExpanded={expandedStep === "deploy"}
            onToggle={() => toggleStep("deploy")}
          />
        )}

        {steps.pwaInstall.show && (
          <PWAInstallStep
            isExpanded={expandedStep === "pwa"}
            onToggle={() => toggleStep("pwa")}
            onComplete={actions.completePWAInstall}
            onSkip={actions.skipPWAInstall}
            onSkipPermanently={actions.skipPWAInstallPermanently}
            showSkipPermanently={steps.pwaInstall.showSkipPermanently}
            isComplete={steps.pwaInstall.complete}
          />
        )}
      </div>
    </div>
  );
}
