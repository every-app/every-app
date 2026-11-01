import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
} from "lucide-react";
import { cn } from "cn";
import type { AppSetup } from "@every-app/sdk/internal";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Button } from "@/client/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/client/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  PLATFORM_NOTE,
  STATUS_COMMAND,
  SetupAction,
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
 * What an app needs set before it opens. Whoever can run the command gets
 * three steps: get the keys, run `everyapp configure <app>`, come back; a
 * member is told to ask an admin. Each setting ticks off as it lands
 * (the dialog renders from the live list, useSetupDialog), and the dialog
 * closes by itself once the app no longer needs setup. Closes from the
 * footer alone, like every other dialog.
 */
export function AppSetupDialog({
  name,
  setup,
  canRun,
  onClose,
}: AppSetupDialogProps) {
  const model = setupDialogModel(setup, { name, canRun });
  const { action } = model;
  const needed = (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {model.needed.map((row) => (
          <NeededRow key={row.id} row={row} />
        ))}
      </ul>
      {model.anyOf.map((line) => (
        <p key={line} className="text-xs text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
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
        {/* Only the body scrolls, under a fixed title and footer; min-w-0
            keeps a long name from widening the dialog's grid column, and
            the inset keeps focus rings clear of the scroll edge. */}
        <div className="-mx-1 flex max-h-[60vh] min-w-0 flex-col gap-5 overflow-y-auto px-1 py-0.5">
          {action.kind === SetupAction.Run ? (
            <ol className="flex flex-col gap-5">
              <Step n={1} title={model.gather}>
                {needed}
              </Step>
              <Step n={2} title="Run this in a terminal">
                <CodeBlock
                  code={action.command}
                  successMessage="Command copied"
                />
              </Step>
              <Step n={3} title={`Come back here: ${name} opens on its own`} />
            </ol>
          ) : (
            <>
              {needed}
              {action.kind === SetupAction.AskAdmin ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Ask an admin to run:</p>
                  <CodeBlock
                    code={action.command}
                    successMessage="Command copied"
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{PLATFORM_NOTE}</p>
              )}
            </>
          )}
          {model.optional.length > 0 ? (
            <OptionalSettings
              rows={model.optional}
              summary={model.optionalSummary}
            />
          ) : null}
        </div>
        <DialogFooter showCloseButton>
          {model.statusHint ? (
            <p className="text-xs text-muted-foreground sm:mr-auto sm:self-center">
              Already set it another way?{" "}
              <span className="font-mono">{STATUS_COMMAND}</span> re-reads the
              Worker.
            </p>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
      <span className="flex size-6 items-center justify-center rounded-full border border-border bg-muted text-xs font-medium tabular-nums">
        {n}
      </span>
      <p className="self-center text-sm font-medium">{title}</p>
      {children ? <div className="col-start-2 mt-2">{children}</div> : null}
    </li>
  );
}

/**
 * A setting the app can't open without: open, with why and where to get
 * it, or ticked off once set.
 */
function NeededRow({ row }: { row: SetupDialogRow }) {
  return (
    <li className="flex items-start gap-3 p-3">
      {row.done ? (
        <CircleCheck
          className="mt-0.5 size-4 shrink-0 text-success"
          aria-hidden
        />
      ) : (
        <Circle
          className="mt-0.5 size-4 shrink-0 text-muted-foreground/60"
          aria-hidden
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label row={row} />
        {row.done ? null : <Details row={row} />}
      </div>
      {row.done ? (
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs text-success">
          <Check className="size-3" aria-hidden />
          Set
        </span>
      ) : row.docs ? (
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={
            <a
              href={row.docs.href}
              target="_blank"
              rel="noreferrer"
              title={row.docs.href}
            />
          }
        >
          {row.takes ? "Docs" : "Get key"}
          <ArrowUpRight aria-hidden />
        </Button>
      ) : null}
    </li>
  );
}

/** The settings the app works without, folded to one line. */
function OptionalSettings({
  rows,
  summary,
}: {
  rows: SetupDialogRow[];
  summary: string;
}) {
  return (
    <Collapsible className="rounded-lg border border-dashed border-border">
      <CollapsibleTrigger className="group/optional flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/optional:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <span className="shrink-0 font-medium">
          Add later · {rows.length} optional
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-data-panel-open/optional:invisible">
          {summary}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="divide-y divide-border border-t border-dashed border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1 px-3 py-2.5">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1">
                  <Label row={row} />
                </span>
                {row.docs ? (
                  <a
                    href={row.docs.href}
                    target="_blank"
                    rel="noreferrer"
                    title={row.docs.href}
                    className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground underline-offset-3 hover:text-foreground hover:underline"
                  >
                    {row.docs.host}
                    <ArrowUpRight className="size-3" aria-hidden />
                  </a>
                ) : null}
              </div>
              <Details row={row} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** An app's own secret is labelled by its name, so it is set in the same type as a name. */
function Label({ row }: { row: SetupDialogRow }) {
  return (
    <span
      className={cn(
        "text-sm font-medium wrap-anywhere",
        row.names.length === 0 && "font-mono",
        row.done && "text-muted-foreground line-through",
      )}
    >
      {row.label}
    </span>
  );
}

/** Why the app needs it, what a plain setting takes, and its names. */
function Details({ row }: { row: SetupDialogRow }) {
  return (
    <>
      {row.why ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {row.why}
        </p>
      ) : null}
      {row.takes ? (
        <p className="text-xs text-muted-foreground">Takes {row.takes}</p>
      ) : null}
      {row.names.length > 0 ? (
        <span className="flex flex-wrap gap-1 font-mono text-[0.7rem] text-muted-foreground">
          {row.names.map((name) => (
            <span
              key={name}
              className="rounded bg-muted px-1 py-px wrap-anywhere"
            >
              {name}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}
