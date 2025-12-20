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

  // Calculate step numbers dynamically
  const deployStepNumber = 1;
  const pwaStepNumber = steps.deployApp.show ? 2 : 1;

  return (
    <div className="bg-gradient-to-r from-primary/10 to-secondary/10 border border-primary/20 rounded-xl p-4 sm:p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-1">
          <h2 className="font-bold text-lg">Get started with Every App</h2>
          <p className="text-sm text-base-content/70">
            {progress.completed === progress.total
              ? "You're all set!"
              : `Complete ${progress.total - progress.completed} step${progress.total - progress.completed > 1 ? "s" : ""} to get the most out of Every App`}
          </p>
        </div>
        <div className="text-sm font-medium text-primary">
          {progress.completed}/{progress.total}
        </div>
      </div>

      {/* Progress bar */}
      {progress.completed > 0 && (
        <div className="w-full bg-base-300 rounded-full h-2 mb-4">
          <div
            className="bg-primary h-2 rounded-full transition-all duration-300"
            style={{
              width: `${(progress.completed / progress.total) * 100}%`,
            }}
          />
        </div>
      )}

      {/* Steps */}
      <div className="space-y-3">
        {steps.deployApp.show && (
          <DeployAppStep
            isExpanded={expandedStep === "deploy"}
            onToggle={() => toggleStep("deploy")}
            stepNumber={deployStepNumber}
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
            stepNumber={pwaStepNumber}
          />
        )}
      </div>
    </div>
  );
}
