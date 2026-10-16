import { ChevronRight, Monitor, Rocket, Terminal } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/client/components/ui/collapsible";

interface DeployAppStepProps {
  isExpanded: boolean;
  onToggle: () => void;
}

export function DeployAppStep({ isExpanded, onToggle }: DeployAppStepProps) {
  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle()}>
      <CollapsibleTrigger className="group flex w-full items-center gap-3 px-5 py-4 text-left text-sm font-medium outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset aria-expanded:bg-primary/5 sm:px-6">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
          <Rocket className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block">Deploy your first app</span>
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            Self-host an app to get started with Every App
          </span>
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-5 px-5 py-5 text-sm sm:px-6">
        {/* Mobile message - shown on small screens */}
        <Alert variant="info" className="sm:hidden">
          <Monitor />
          <AlertTitle>Open this page on your computer</AlertTitle>
          <AlertDescription>
            Deploying an app requires running terminal commands. Please visit
            this page on your computer to see the deployment instructions.
          </AlertDescription>
        </Alert>

        {/* Desktop instructions - hidden on small screens */}
        <div className="hidden space-y-3 sm:block">
          <p className="flex items-center gap-2 font-medium">
            <Terminal className="size-4 text-muted-foreground" aria-hidden />
            Follow these steps in your terminal
          </p>

          <ol className="list-decimal space-y-3 pl-5 marker:text-muted-foreground">
            <li>
              In your checkout of the Every App repository, go to the Todo App
              <div className="mt-2">
                <CodeBlock code="cd apps/todo-app" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
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

        <p className="hidden text-muted-foreground sm:block">
          Ready to build your own app? Check out the{" "}
          <a
            href="https://everyapp.dev/docs/build-an-app/start-from-template"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4"
          >
            Start from Template
          </a>{" "}
          guide.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
