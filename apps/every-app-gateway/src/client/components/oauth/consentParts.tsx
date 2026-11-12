import {
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { ArrowLeftRight, BadgeCheck, CheckIcon } from "lucide-react";
import { cn } from "cn";
import { CONSENT_FIELDS } from "@/schemas/consent-decision";
import { Badge } from "@/client/components/ui/badge";
import { Button, buttonVariants } from "@/client/components/ui/button";
import { Card, CardContent } from "@/client/components/ui/card";
import { Spinner } from "@/client/components/ui/spinner";

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

/** What the consent pages show in place of a client's logo, never loaded. */
export function InitialsTile({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-base font-semibold text-primary",
        className,
      )}
    >
      {initials(name)}
    </div>
  );
}

/** The one card a consent page is, with more room around it from a tablet up. */
export function ConsentCard({ children }: { children: ReactNode }) {
  return (
    <Card className="sm:[--card-spacing:--spacing(8)]">
      <CardContent className="space-y-6">{children}</CardContent>
    </Card>
  );
}

/**
 * A box of ConsentRows inside the card: the account an app would use, where
 * access goes, what to choose. Two columns: the labels, as wide as the
 * longest one, and the rest, where every control is one width, so the
 * controls share both edges whatever they hold.
 */
export function ConsentBox({ children }: { children: ReactNode }) {
  return (
    <div className="@container">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-lg border border-border bg-muted/50 px-3 py-3 text-sm sm:px-4">
        {children}
      </dl>
    </div>
  );
}

/**
 * The top of a consent page: who asks (`from`) and what it would reach
 * (`to`), each a 48px tile, the question, and one line under it.
 */
export function ConsentHeader({
  from,
  to,
  title,
  children,
}: {
  from: ReactNode;
  to: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col items-center text-center">
      <div aria-hidden className="flex items-center gap-3">
        {from}
        <ArrowLeftRight className="size-4 text-muted-foreground" />
        {to}
      </div>
      <h1
        className="mt-4 line-clamp-3 text-xl font-semibold text-balance break-words"
        title={title}
      >
        {title}
      </h1>
      {children}
    </header>
  );
}

/**
 * Under a consent page's title, who vouches for the client's name: the
 * domain that publishes its details, when that domain covers where it sends
 * access (`verified`), or nobody, for a client that registered itself.
 * Nothing for a domain that doesn't cover it: the page warns about that.
 */
export function ClientPublisher({
  domain,
  verified,
}: {
  domain: string | null;
  verified: boolean;
}) {
  if (verified) {
    return (
      <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
        <BadgeCheck className="size-4 shrink-0 text-success" />
        <span>
          Published by{" "}
          <strong className="font-medium text-foreground">{domain}</strong>
        </span>
      </p>
    );
  }
  if (domain) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
      <Badge variant="outline" size="sm">
        Unverified
      </Badge>
      <span>Continue if you trust this application.</span>
    </p>
  );
}

/**
 * One answer per page: a double-clicked button would send the form twice.
 * `sentDecision` is the pressed button's decision once the form is sent
 * ("" when it was sent without a button), for its spinner.
 */
export function useSendOnce() {
  const sent = useRef(false);
  const [sentDecision, setSentDecision] = useState<string | null>(null);
  return {
    sentDecision,
    onSubmit(event: FormEvent<HTMLFormElement>) {
      if (sent.current) {
        event.preventDefault();
        return;
      }
      sent.current = true;
      const { submitter } = event.nativeEvent as SubmitEvent;
      setSentDecision(submitter?.getAttribute("value") ?? "");
    },
  };
}

/** The decline and allow buttons, each posting its decision. */
export function DecisionButtons({
  sentDecision,
  canAllow,
  denyLabel = "Deny",
}: {
  sentDecision: string | null;
  canAllow: boolean;
  denyLabel?: string;
}) {
  const sending = sentDecision !== null;
  // Not `disabled`: a submit button disabled while its form is being sent
  // drops out of what is sent, and with it the decision.
  const sendingClassName = sending ? "pointer-events-none opacity-50" : "";
  return (
    // Allow sits on top, but the decline button comes first in the form, so
    // it stays the default button: the one an Enter outside a button presses.
    <div className="flex flex-col-reverse gap-2">
      <button
        type="submit"
        name={CONSENT_FIELDS.decision}
        value="deny"
        className={cn(buttonVariants({ variant: "outline" }), sendingClassName)}
        aria-disabled={sending}
      >
        {sentDecision === "deny" ? <Spinner data-icon="inline-start" /> : null}
        {denyLabel}
      </button>
      <button
        type="submit"
        name={CONSENT_FIELDS.decision}
        value="approve"
        className={cn(buttonVariants(), sendingClassName)}
        aria-disabled={sending}
        disabled={!canAllow}
      >
        {sentDecision === "approve" ? (
          <Spinner data-icon="inline-start" />
        ) : null}
        Allow
      </button>
    </div>
  );
}

/**
 * Who is signed in, one centered line under the header, with the way to
 * switch accounts when there is one (behind Cloudflare Access there isn't:
 * the browser can only be the person Access says it is).
 */
export function SignedInRow({
  email,
  onSwitchAccount,
}: {
  email: string;
  onSwitchAccount?: () => void;
}) {
  return (
    <p className="text-center text-sm text-muted-foreground wrap-anywhere">
      Signed in as{" "}
      <strong className="font-medium text-foreground">{email}</strong>
      {onSwitchAccount ? (
        <>
          {" · "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 align-baseline"
            onClick={onSwitchAccount}
          >
            Switch account
          </Button>
        </>
      ) : null}
    </p>
  );
}

/**
 * One row of a ConsentBox: a label, and beside it a fact, set at the row's
 * end, or a `control`. Every control in a box is the same width: its whole
 * column on a phone, 200px at the row's end from a tablet up. In a box too
 * narrow for a control beside its label (a small phone), the control goes
 * under it. `htmlFor` is the id of the control the label names.
 */
export function ConsentRow({
  label,
  htmlFor,
  control = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  control?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "col-span-2 grid items-baseline gap-y-1.5",
        control ? "@xs:grid-cols-subgrid" : "grid-cols-subgrid",
      )}
    >
      <dt className="text-muted-foreground">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
      </dt>
      <dd
        className={cn(
          "min-w-0 font-medium",
          control ? "sm:w-50 sm:justify-self-end" : "text-right wrap-anywhere",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * A choice between a few short options, side by side in equal parts of the
 * space it is given. Native radios drawn as one control, not Base UI's
 * toggle group: the form posts natively, so each option must be a real
 * input with its own name and value.
 */
export function Segmented<TValue extends string>({
  label,
  name,
  options,
  defaultValue,
  onChange,
}: {
  /** What is being chosen, for a screen reader. */
  label: string;
  name: string;
  options: readonly { value: TValue; label: string }[];
  defaultValue: TValue;
  onChange?: (value: TValue) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid h-8 auto-cols-fr grid-flow-col rounded-lg border border-input bg-card p-0.5 dark:bg-input/30"
    >
      {options.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-center justify-center rounded-md px-1 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors has-checked:bg-foreground/10 has-checked:text-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
        >
          <input
            type="radio"
            className="sr-only"
            name={name}
            value={option.value}
            defaultChecked={option.value === defaultValue}
            onChange={() => onChange?.(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/**
 * A checkbox with its label. A native input styled like the shadcn one, not
 * Base UI's: the form posts natively, so each choice must be a real input
 * with its own name and value.
 */
export function NativeCheckbox({
  hint,
  children,
  ...props
}: Omit<ComponentProps<"input">, "type" | "className"> & {
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-50">
      <span className="relative grid size-4 shrink-0 place-items-center">
        <input
          type="checkbox"
          className="peer size-4 cursor-pointer appearance-none rounded-[4px] border border-input outline-none transition-colors checked:border-primary checked:bg-primary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed dark:bg-input/30 dark:checked:bg-primary"
          {...props}
        />
        <CheckIcon
          aria-hidden
          className="pointer-events-none absolute size-3.5 text-primary-foreground opacity-0 peer-checked:opacity-100"
        />
      </span>
      <span>{children}</span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}
