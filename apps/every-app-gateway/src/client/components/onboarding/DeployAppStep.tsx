import { ChevronDown, ChevronRight, Monitor, Terminal } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";

interface DeployAppStepProps {
  isExpanded: boolean;
  onToggle: () => void;
  stepNumber: number;
}

export function DeployAppStep({
  isExpanded,
  onToggle,
  stepNumber,
}: DeployAppStepProps) {
  return (
    <div className="border border-base-content/20 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-base-200 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded-full border-2 border-primary flex items-center justify-center">
            <span className="text-xs font-bold text-primary">{stepNumber}</span>
          </div>
          <div>
            <h3 className="font-semibold">Deploy your first app</h3>
            <p className="text-sm text-base-content/70">
              Self-host an app to get started with Every App
            </p>
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="w-5 h-5 text-base-content/50" />
        ) : (
          <ChevronRight className="w-5 h-5 text-base-content/50" />
        )}
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 pt-2 space-y-4">
          {/* Mobile message - shown on small screens */}
          <div className="sm:hidden bg-base-200/50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Monitor className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">
                Open this page on your computer
              </span>
            </div>
            <p className="text-sm text-base-content/70">
              Deploying an app requires running terminal commands. Please visit
              this page on your computer to see the deployment instructions.
            </p>
          </div>

          {/* Desktop instructions - hidden on small screens */}
          <div className="hidden sm:block bg-base-200/50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">
                Follow these steps in your terminal
              </span>
            </div>

            <ol className="space-y-4">
              <li>
                <div className="flex items-start gap-2">
                  <span className="text-sm font-semibold text-primary min-w-[24px]">
                    1.
                  </span>
                  <div className="flex-1">
                    <p className="text-sm mb-2">Clone the Todo App template</p>
                    <CodeBlock code="npx gitpick every-app/every-app/tree/main/apps/todo-app every-todo-app" />
                    <p className="text-xs text-base-content/60 mt-1">
                      This clones Todo App from the Every App monorepo
                    </p>
                  </div>
                </div>
              </li>

              <li>
                <div className="flex items-start gap-2">
                  <span className="text-sm font-semibold text-primary min-w-[24px]">
                    2.
                  </span>
                  <div className="flex-1">
                    <p className="text-sm mb-2">
                      Navigate to the app directory
                    </p>
                    <CodeBlock code="cd every-todo-app" />
                  </div>
                </div>
              </li>

              <li>
                <div className="flex items-start gap-2">
                  <span className="text-sm font-semibold text-primary min-w-[24px]">
                    3.
                  </span>
                  <div className="flex-1">
                    <p className="text-sm mb-2">Deploy the app</p>
                    <CodeBlock code="every app deploy" />
                  </div>
                </div>
              </li>

              <li>
                <div className="flex items-start gap-2">
                  <span className="text-sm font-semibold text-primary min-w-[24px]">
                    4.
                  </span>
                  <div className="flex-1">
                    <p className="text-sm">
                      Refresh this page and your app will appear in the list
                      above!
                    </p>
                  </div>
                </div>
              </li>
            </ol>
          </div>

          <p className="hidden sm:block text-sm text-base-content/70">
            Ready to build your own app? Check out the{" "}
            <a
              href="https://everyapp.dev/docs/build-an-app/start-from-template"
              target="_blank"
              rel="noopener noreferrer"
              className="link link-primary"
            >
              Start from Template
            </a>{" "}
            guide.
          </p>
        </div>
      )}
    </div>
  );
}
