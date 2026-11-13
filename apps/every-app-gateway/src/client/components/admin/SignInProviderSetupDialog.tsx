import { ExternalLink, TriangleAlert } from "lucide-react";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Badge } from "@/client/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  signInSetupDialogModel,
  type ListedSignInProvider,
} from "@/client/lib/signInProviders";

interface SignInProviderSetupDialogProps {
  provider: ListedSignInProvider;
  /** The reader can run `everyapp signin add` (a self-hosted gateway). */
  canRun: boolean;
  onClose: () => void;
}

const STATE_BADGE = {
  Set: "success",
  "Not set": "warning",
  Optional: "outline",
} as const;

/**
 * What setting up one sign-in provider takes, in the spirit of the app
 * Needs-setup dialog (AppSetupDialog): the OAuth app to make at the
 * provider and the redirect URL to register there, the settings with which
 * are set (never a value), and the one command that sets them from a
 * terminal. Nothing here changes a setting.
 */
export function SignInProviderSetupDialog({
  provider,
  canRun,
  onClose,
}: SignInProviderSetupDialogProps) {
  const model = signInSetupDialogModel(provider, { canRun });
  const redirectUrl = (
    <CodeBlock code={model.callbackUrl} successMessage="Redirect URL copied" />
  );
  const command = (
    <CodeBlock code={model.command} successMessage="Command copied" />
  );
  const settings = (
    <section className="flex flex-col gap-2">
      <p className="text-sm font-medium">Settings</p>
      <ul className="flex flex-col gap-3">
        {model.settings.map((setting) => (
          <li key={setting.name} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{setting.name}</span>
              <Badge variant={STATE_BADGE[setting.state]} size="sm">
                {setting.state}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{setting.what}</p>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{model.title}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          {model.problem ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription>{model.problem}</AlertDescription>
            </Alert>
          ) : null}

          {model.on ? (
            <>
              <section className="flex flex-col gap-2">
                <p className="text-sm font-medium">Redirect URL</p>
                {redirectUrl}
              </section>
              {settings}
              <section className="flex flex-col gap-2">
                <p className="text-sm font-medium">{model.commandHeading}</p>
                {command}
              </section>
            </>
          ) : (
            <>
              <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm font-medium">
                <li>
                  Create the {model.appNoun}
                  {model.console ? (
                    <>
                      {" at "}
                      <a
                        href={model.console.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 underline underline-offset-3 hover:text-primary"
                      >
                        {model.console.label}
                        <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    </>
                  ) : model.consoleText ? (
                    ` in ${model.consoleText}`
                  ) : null}
                </li>
                <li>
                  Give it this redirect URL
                  <div className="mt-2 -ml-5 font-normal">{redirectUrl}</div>
                </li>
                <li>
                  {model.commandHeading}
                  <div className="mt-2 -ml-5 font-normal">{command}</div>
                </li>
              </ol>
              {settings}
            </>
          )}

          {model.notes.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {model.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter showCloseButton>
          <p className="text-xs text-muted-foreground sm:mr-auto sm:self-center">
            <a
              className="underline underline-offset-2"
              href={`https://everyapp.com/docs/agent/${model.guide.replace(/\.md$/, "")}`}
              target="_blank"
              rel="noreferrer"
            >
              Guide for your agent
            </a>
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
