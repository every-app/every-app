import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
} from "lucide-react";
import { cn } from "cn";
import type { AppSetup, FeatureState } from "@every-app/sdk/internal";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Badge } from "@/client/components/ui/badge";
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
  PROVIDERS_PATH,
  STATUS_COMMAND,
  SetupAction,
  setupDialogModel,
  type InlinePart,
  type SetupDialogFeature,
  type SetupDialogRow,
} from "@/client/lib/appSetup";

interface AppSetupDialogProps {
  name: string;
  /** The app's hostname, for `{appUrl}` in its features' steps; null leaves it unfilled. */
  hostname: string | null;
  setup: AppSetup;
  /** Whoever reads it can run the command: an owner or admin. */
  canRun: boolean;
  onClose: () => void;
}

const STATE_BADGE: Record<
  FeatureState,
  { label: string; variant: "success" | "warning" | "outline" }
> = {
  ready: { label: "Ready", variant: "success" },
  incomplete: { label: "Incomplete", variant: "warning" },
  off: { label: "Off", variant: "outline" },
};

/**
 * What an app needs set before it opens, grouped as `everyapp configure`
 * walks it: what is always needed, then each feature with its steps and
 * values. Whoever can run the command gets three steps: get the keys, run
 * `everyapp configure <app>`, come back, then the optional features,
 * folded while off; a member is told to ask an admin. Each setting ticks
 * off as it lands (the dialog renders from the live list,
 * useSetupDialog), and the dialog closes by itself once the app no longer
 * needs setup. Closes from the footer alone, like every other dialog.
 */
export function AppSetupDialog({
  name,
  hostname,
  setup,
  canRun,
  onClose,
}: AppSetupDialogProps) {
  const model = setupDialogModel(setup, {
    name,
    canRun,
    urls: {
      appUrl: hostname
        ? `${window.location.protocol}//${hostname}`
        : "{appUrl}",
      gatewayUrl: window.location.origin,
    },
  });
  const { action } = model;
  const runs = action.kind === SetupAction.Run;
  const grouped = model.required.length > 0 || model.optional.length > 0;
  const needed = (
    <div className="flex flex-col gap-4">
      {model.always.length > 0 ? (
        <div className="flex flex-col gap-2">
          {grouped ? (
            <p className="text-xs font-medium text-muted-foreground">
              Always needed
            </p>
          ) : null}
          <ul className="divide-y divide-border rounded-lg border border-border">
            {model.always.map((row) => (
              <NeededRow key={row.id} row={row} />
            ))}
          </ul>
        </div>
      ) : null}
      {model.required.map((feature) => (
        <FeatureSection key={feature.id} feature={feature} runs={runs} />
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
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                Optional
              </p>
              {model.optional.map((feature) => (
                <OptionalFeature
                  key={feature.id}
                  feature={feature}
                  runs={runs}
                />
              ))}
            </div>
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

/** A feature's name with whether it is needed and its state. */
function FeatureHeading({ feature }: { feature: SetupDialogFeature }) {
  const state = STATE_BADGE[feature.state];
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <span className="text-sm font-medium wrap-anywhere">{feature.name}</span>
      <Badge variant="secondary" size="sm">
        {feature.required ? "Required" : "Optional"}
      </Badge>
      <Badge variant={state.variant} size="sm">
        {state.label}
      </Badge>
    </span>
  );
}

/** Why, the numbered steps, its values, and the Gateway settings it needs. */
function FeatureBody({
  feature,
  runs,
}: {
  feature: SetupDialogFeature;
  runs: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      {feature.why ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {feature.why}
        </p>
      ) : null}
      {feature.steps.length > 0 ? (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs leading-relaxed marker:text-muted-foreground">
          {feature.steps.map((step, index) => (
            <li key={index}>
              <Inline parts={step} />
            </li>
          ))}
        </ol>
      ) : null}
      {feature.values.length + feature.gateway.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {feature.values.map((row) => (
            <NeededRow key={row.id} row={row} />
          ))}
          {feature.gateway.map((row) => (
            <GatewayRow key={row.id} row={row} runs={runs} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A feature the app can't open without: always open. */
function FeatureSection({
  feature,
  runs,
}: {
  feature: SetupDialogFeature;
  runs: boolean;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border">
      <div className="px-3 pt-2.5">
        <FeatureHeading feature={feature} />
      </div>
      <FeatureBody feature={feature} runs={runs} />
    </section>
  );
}

/** A feature the app works without: folded while off, with "Set up" to open it. */
function OptionalFeature({
  feature,
  runs,
}: {
  feature: SetupDialogFeature;
  runs: boolean;
}) {
  return (
    <Collapsible
      defaultOpen={feature.state === "incomplete"}
      className="rounded-lg border border-dashed border-border"
    >
      <CollapsibleTrigger className="group/feature flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open/feature:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        <FeatureHeading feature={feature} />
        {feature.state === "off" ? (
          <span className="shrink-0 text-xs font-medium text-primary group-data-panel-open/feature:invisible">
            Set up
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FeatureBody feature={feature} runs={runs} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A step's or a value's Markdown: text, code, and links that open in a new tab. */
function Inline({ parts }: { parts: InlinePart[] }) {
  return (
    <span className="wrap-anywhere">
      {parts.map((part, index) =>
        part.kind === "link" ? (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-3 hover:text-primary"
          >
            {part.text}
          </a>
        ) : part.kind === "code" ? (
          <code key={index} className="rounded bg-muted px-1 py-px font-mono">
            {part.text}
          </code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function SetMark({ done }: { done: boolean }) {
  return done ? (
    <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
  ) : (
    <Circle
      className="mt-0.5 size-4 shrink-0 text-muted-foreground/60"
      aria-hidden
    />
  );
}

function SetLabel() {
  return (
    <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs text-success">
      <Check className="size-3" aria-hidden />
      Set
    </span>
  );
}

/**
 * A setting the app needs: open, with why, where it lives and where to
 * get it, or ticked off once set.
 */
function NeededRow({ row }: { row: SetupDialogRow }) {
  return (
    <li className="flex items-start gap-3 p-3">
      <SetMark done={row.done} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label row={row} />
        {row.done ? null : <Details row={row} />}
      </div>
      {row.done ? (
        <SetLabel />
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
      ) : (
        <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">
          Not set
        </span>
      )}
    </li>
  );
}

/**
 * A Gateway setting a feature needs: set, or not yet, with where an owner
 * or admin adds it (Manage workspace → Providers).
 */
function GatewayRow({ row, runs }: { row: SetupDialogRow; runs: boolean }) {
  return (
    <li className="flex items-start gap-3 p-3">
      <SetMark done={row.done} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium wrap-anywhere">{row.label}</span>
        <span className="text-xs text-muted-foreground">
          {row.done ? "Set on the Gateway" : "Not set on the Gateway"}
        </span>
      </div>
      {row.done ? (
        <SetLabel />
      ) : runs ? (
        <a
          href={PROVIDERS_PATH}
          className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground underline-offset-3 hover:text-foreground hover:underline"
        >
          Providers
          <ArrowUpRight className="size-3" aria-hidden />
        </a>
      ) : null}
    </li>
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

/** Why the app needs it, where it lives, what a plain setting takes, and its names. */
function Details({ row }: { row: SetupDialogRow }) {
  return (
    <>
      {row.why ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {row.why}
        </p>
      ) : null}
      {row.how ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          <Inline parts={row.how} />
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
