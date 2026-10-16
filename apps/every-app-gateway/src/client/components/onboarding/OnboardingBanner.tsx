import { useState } from "react";
import { useOnboarding } from "@/client/hooks/useOnboarding";
import { Badge } from "@/client/components/ui/badge";
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
    <section
      aria-label="Onboarding checklist"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-5 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Get started with Every App</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Deploy an app and it shows up on this page.
          </p>
        </div>
        {progress.total > 0 && (
          <Badge variant="soft" className="tabular-nums">
            {progress.completed}/{progress.total}
          </Badge>
        )}
      </header>

      <DeployAppStep
        isExpanded={isExpanded}
        onToggle={() => setUserCollapsed(isExpanded)}
      />
    </section>
  );
}
