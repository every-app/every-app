import { Monitor } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Alert, AlertDescription } from "@/client/components/ui/alert";

/** Shown on the home page while the organization has no apps. */
export function OnboardingBanner() {
  return (
    <section
      aria-label="Deploy your first app"
      className="rounded-xl border border-border bg-card text-card-foreground shadow-xs"
    >
      <header className="border-b border-border px-5 py-5 sm:px-6">
        <h2 className="text-lg font-semibold">Deploy your first app</h2>
      </header>
      <div className="space-y-4 px-5 py-5 text-sm leading-relaxed sm:px-6">
        <Alert variant="info" className="sm:hidden">
          <Monitor />
          <AlertDescription className="text-foreground">
            Deploying takes a terminal. Open this page on a computer.
          </AlertDescription>
        </Alert>
        <ol className="hidden max-w-2xl list-decimal space-y-4 pl-5 marker:font-medium sm:block">
          <li>
            Create an app from the starter
            <div className="mt-2">
              <CodeBlock code="pnpm everyapp create my-app" />
            </div>
          </li>
          <li>
            Deploy it
            <div className="mt-2">
              <CodeBlock code="cd apps/my-app && pnpm run deploy" />
            </div>
          </li>
        </ol>
        <p className="hidden text-muted-foreground sm:block">
          Refresh this page and it appears here. Docs:{" "}
          <a
            href="https://everyapp.com/docs/create-an-app"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4"
          >
            Start from template
          </a>
          .
        </p>
      </div>
    </section>
  );
}
