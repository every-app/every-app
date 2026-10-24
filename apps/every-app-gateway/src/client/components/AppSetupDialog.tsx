import { ChevronRight, ExternalLink } from "lucide-react";
import type { AppSetup } from "@every-app/sdk/internal";
import { CodeBlock } from "@/client/components/CodeBlock";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/client/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  STATUS_COMMAND,
  setupDialogModel,
  type SetupDialogRow,
} from "@/client/lib/appSetup";

interface AppSetupDialogProps {
  name: string;
  setup: AppSetup;
  /** Whoever reads it can run the command: an owner or admin. */
  canRun: boolean;
  onClose: () => void;
}

/**
 * What an app needs set before it opens, and the one command that sets it
 * (`everyapp secret set`), for whoever can run it; a member is told to
 * ask an admin. Render it only while it is open.
 */
export function AppSetupDialog({
  name,
  setup,
  canRun,
  onClose,
}: AppSetupDialogProps) {
  const model = setupDialogModel(setup, { name, canRun });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{model.title}</DialogTitle>
          <DialogDescription>{model.intro}</DialogDescription>
        </DialogHeader>
        {model.unmet.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {model.unmet.map((row) => (
              <SettingRow key={row.id} row={row} />
            ))}
          </ul>
        ) : null}
        {model.anyOf.map((line) => (
          <p key={line} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
        {model.command ? (
          <div className="flex flex-col gap-2">
            {model.command.heading ? (
              <p className="text-sm font-medium">{model.command.heading}</p>
            ) : null}
            <CodeBlock
              code={model.command.command}
              successMessage="Command copied"
            />
            {model.command.note ? (
              <p className="text-xs text-muted-foreground">
                {model.command.note}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{model.platformNote}</p>
        )}
        {model.optional.length > 0 ? (
          <Collapsible className="flex flex-col gap-2">
            <CollapsibleTrigger className="group/optional -ml-1 flex w-fit cursor-pointer items-center gap-1 rounded-md px-1 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
              <ChevronRight
                className="size-4 transition-transform group-data-panel-open/optional:rotate-90 motion-reduce:transition-none"
                aria-hidden
              />
              Optional ({model.optional.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="flex flex-col gap-3 border-l border-border pl-3">
                {model.optional.map((row) => (
                  <SettingRow key={row.id} row={row} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <DialogFooter showCloseButton>
          <p className="text-xs text-muted-foreground sm:mr-auto sm:self-center">
            Already set it another way?{" "}
            <span className="font-mono">{STATUS_COMMAND}</span> re-reads the
            Worker.
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One setting: its label and names, why the app needs it, where it comes from. */
function SettingRow({ row }: { row: SetupDialogRow }) {
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium">{row.label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {row.names.join(" ")}
        </span>
      </div>
      {row.why ? (
        <p className="text-sm text-muted-foreground">{row.why}</p>
      ) : null}
      {row.docs ? (
        <a
          href={row.docs.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1 text-sm underline underline-offset-3 hover:text-foreground"
        >
          Get it at {row.docs.label}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ) : null}
    </li>
  );
}
