import { Monitor, Rocket, Terminal } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
export function DeployAppStep() {
  return (
    <div>
      <div className="flex items-center gap-3 px-5 py-4 text-sm text-foreground sm:px-6">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
          <Rocket className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">Deploy your first app</h3>
          <p className="mt-1 text-foreground/80">
            Start with the Todo App included in this repository.
          </p>
        </div>
      </div>

      <div className="space-y-5 border-t border-border bg-background/40 px-5 py-5 text-sm leading-relaxed text-foreground sm:px-6">
        {/* Mobile message - shown on small screens */}
        <Alert variant="info" className="sm:hidden">
          <Monitor />
          <AlertTitle>Open this page on your computer</AlertTitle>
          <AlertDescription className="text-foreground">
            Deploying an app requires running terminal commands. Please visit
            this page on your computer to see the deployment instructions.
          </AlertDescription>
        </Alert>

        {/* Desktop instructions - hidden on small screens */}
        <div className="hidden max-w-2xl space-y-4 sm:block">
          <p className="flex items-center gap-2 font-medium">
            <Terminal className="size-4 text-muted-foreground" aria-hidden />
            Follow these steps in your terminal
          </p>

          <ol className="list-decimal space-y-4 pl-5 marker:font-medium marker:text-foreground">
            <li>
              In your checkout of the Every App repository, go to the Todo App
              <div className="mt-2">
                <CodeBlock code="cd apps/todo-app" />
              </div>
              <p className="mt-2 text-sm text-foreground/80">
                Apps deploy from the repository, with the CLI in it
              </p>
            </li>
            <li>
              Deploy the app
              <div className="mt-2">
                <CodeBlock code="pnpm run deploy" />
              </div>
            </li>
            <li>Refresh this page and your app will appear in the list.</li>
          </ol>
        </div>

        <p className="hidden text-foreground sm:block">
          Ready to build your own app? Check out the{" "}
          <a
            href="https://everyapp.com/docs/build-your-own-app"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4"
          >
            Start from Template
          </a>{" "}
          guide.
        </p>
      </div>
    </div>
  );
}
