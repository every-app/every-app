import { DeployAppStep } from "./DeployAppStep";

export function OnboardingBanner() {
  return (
    <section
      aria-label="Get started with Every App"
      className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs"
    >
      <header className="border-b border-border px-5 py-5 sm:px-6">
        <h2 className="text-lg font-semibold">Get started with Every App</h2>
      </header>

      <DeployAppStep />
    </section>
  );
}
