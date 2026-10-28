import {
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { CheckIcon, User } from "lucide-react";
import { cn } from "cn";
import { CONSENT_FIELDS } from "@/schemas/consent-decision";
import { Button, buttonVariants } from "@/client/components/ui/button";
import { Spinner } from "@/client/components/ui/spinner";

/** What the consent pages show in place of a client's logo, never loaded. */
export function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
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
    <div className="flex gap-2 pt-2">
      <button
        type="submit"
        name={CONSENT_FIELDS.decision}
        value="deny"
        className={cn(
          buttonVariants({ variant: "ghost" }),
          "flex-1",
          sendingClassName,
        )}
        aria-disabled={sending}
      >
        {sentDecision === "deny" ? <Spinner data-icon="inline-start" /> : null}
        {denyLabel}
      </button>
      <button
        type="submit"
        name={CONSENT_FIELDS.decision}
        value="approve"
        className={cn(buttonVariants(), "flex-1", sendingClassName)}
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

/** "Signed in as", with the way to switch accounts. */
export function SignedInRow({
  email,
  onSwitchAccount,
}: {
  email: string;
  onSwitchAccount: () => void;
}) {
  return (
    // On a phone the button goes under the address, which must stay readable.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <User className="size-4" />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-xs text-muted-foreground">Signed in as</div>
        <div className="truncate font-medium">{email}</div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="ml-10 sm:ml-0"
        onClick={onSwitchAccount}
      >
        Use another account
      </Button>
    </div>
  );
}

/**
 * A radio or checkbox with its label. Native inputs styled like the shadcn
 * ones, not Base UI's: the form posts natively, so each choice must be a real
 * input with its own name and value.
 */
export function Choice({
  type,
  hint,
  children,
  ...props
}: Omit<ComponentProps<"input">, "type" | "className"> & {
  type: "radio" | "checkbox";
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-50">
      <span className="relative grid size-4 shrink-0 place-items-center">
        <input
          type={type}
          className={cn(
            "peer size-4 cursor-pointer appearance-none border border-input outline-none transition-colors checked:border-primary checked:bg-primary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed dark:bg-input/30 dark:checked:bg-primary",
            type === "radio" ? "rounded-full" : "rounded-[4px]",
          )}
          {...props}
        />
        {type === "radio" ? (
          <span
            aria-hidden
            className="pointer-events-none absolute size-2 rounded-full bg-primary-foreground opacity-0 peer-checked:opacity-100"
          />
        ) : (
          <CheckIcon
            aria-hidden
            className="pointer-events-none absolute size-3.5 text-primary-foreground opacity-0 peer-checked:opacity-100"
          />
        )}
      </span>
      <span>{children}</span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}
