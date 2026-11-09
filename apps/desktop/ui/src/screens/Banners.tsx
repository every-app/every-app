import { cn } from "cn";
import { AlertCircle, KeyRound, WifiOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";

function Strip({
  tone,
  icon,
  children,
  action,
}: {
  tone: "quiet" | "attention";
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "animate-in fade-in-0 flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2 text-[12.5px]",
        tone === "quiet"
          ? "border-border bg-muted/60 text-muted-foreground"
          : "border-warning/30 bg-warning/10 text-foreground",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {icon}
        <span className="min-w-0">{children}</span>
      </span>
      {action}
    </div>
  );
}

/** Main can't reach Scribe: recording and the notepad keep going; saves catch up later. */
export function OfflineBanner() {
  return (
    <Strip tone="quiet" icon={<WifiOff className="size-3.5 shrink-0" />}>
      Offline. Recording continues, and notes sync when you're back.
    </Strip>
  );
}

export type SignInAgainProps =
  | {
      /** Every App sign-in again (an OAuth sign-in expired). */
      kind: "oauth";
      signingIn: boolean;
      error?: string;
      onSignIn: () => void;
      onCancel?: () => void;
    }
  | {
      /** The gateway turned a token away: only Every App's sign-in gets through. */
      kind: "everyApp";
      signingIn: boolean;
      error?: string;
      onSignIn: () => void;
      onCancel?: () => void;
    }
  | {
      /** A pasted token stopped working: paste a new one. */
      kind: "token";
      error?: string;
      onSubmitToken: (token: string) => void;
    };

/**
 * The sign-in ran out. Nothing is taken away: the page, the notepad and a recording in
 * progress stay; this asks to sign in again, in place.
 */
export function SignInAgainBanner(props: SignInAgainProps) {
  const [token, setToken] = useState("");
  const icon = <KeyRound className="size-3.5 shrink-0 text-warning" />;
  const message =
    props.kind === "everyApp"
      ? "This workspace needs Sign in with Every App. Your notes and any recording stay as they are."
      : props.kind === "token"
        ? "Your access token stopped working. Paste a new one; your notes and any recording stay as they are."
        : "Your sign-in expired. Your notes and any recording stay as they are.";
  const action =
    props.kind === "token" ? (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) props.onSubmitToken(token.trim());
        }}
      >
        <input
          data-slot="token-input"
          aria-label="New access token"
          type="password"
          autoComplete="off"
          placeholder="Access token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="h-7 w-48 rounded-md border border-input bg-card px-2 text-[12px] outline-none focus:border-ring/50 focus:ring-3 focus:ring-ring/15"
        />
        <Button size="sm" type="submit" disabled={!token.trim()}>
          Sign in
        </Button>
      </form>
    ) : (
      <span className="flex items-center gap-1.5">
        {props.signingIn && props.onCancel && (
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={props.onSignIn} pending={props.signingIn}>
          {props.signingIn
            ? "Waiting for your browser…"
            : props.kind === "everyApp"
              ? "Sign in with Every App"
              : "Sign in again"}
        </Button>
      </span>
    );
  return (
    <Strip tone="attention" icon={icon} action={action}>
      {message}
      {props.error && (
        <span className="mt-0.5 flex items-center gap-1 text-destructive">
          <AlertCircle className="size-3" />
          {props.error}
        </span>
      )}
    </Strip>
  );
}
