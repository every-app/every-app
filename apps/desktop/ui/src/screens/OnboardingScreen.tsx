import { cn } from "cn";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import type { PermissionKind, Permissions } from "../types";
import { TitleBar } from "./AppFrame";
import { PermissionControl, permissionInfo } from "./SettingsScreen";

export type OnboardingStep = "sign-in" | "permissions" | "done";

export interface OnboardingScreenProps {
  step: OnboardingStep;
  /** sign-in */
  onSignIn?: () => void;
  onSubmitToken?: (token: string) => void;
  signingIn?: boolean;
  signInError?: string | null;
  defaultShowToken?: boolean;
  /** The Scribe address to sign in to; shown as a field when `onAppUrlChange` is given. */
  appUrl?: string;
  /** An example address for the field, from the app's feature config (the backend's app id). */
  appUrlPlaceholder?: string;
  onAppUrlChange?: (appUrl: string) => void;
  onCancelSignIn?: () => void;
  /** permissions */
  permissions?: Permissions;
  onGrant?: (kind: PermissionKind) => void;
  onContinue?: () => void;
  /** done */
  onFinish?: () => void;
  accountName?: string;
}

/** The Every App mark: three level bars in a rounded square. Ours, drawn here. */
export function EveryAppMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={cn("size-12", className)}>
      <rect width="48" height="48" rx="12" className="fill-foreground" />
      <rect
        x="14"
        y="19"
        width="4"
        height="10"
        rx="2"
        className="fill-background"
      />
      <rect
        x="22"
        y="13"
        width="4"
        height="22"
        rx="2"
        className="fill-background"
      />
      <rect
        x="30"
        y="17"
        width="4"
        height="14"
        rx="2"
        className="fill-background"
      />
    </svg>
  );
}

const steps: OnboardingStep[] = ["sign-in", "permissions", "done"];

export function OnboardingScreen(props: OnboardingScreenProps) {
  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-8 pb-16">
        <div className="flex w-full max-w-[440px] flex-col items-center text-center">
          {props.step === "sign-in" && <SignIn {...props} />}
          {props.step === "permissions" && <Grant {...props} />}
          {props.step === "done" && <Done {...props} />}
          <ol aria-label="Steps" className="mt-10 flex gap-1.5">
            {steps.map((step) => (
              <li
                key={step}
                aria-current={step === props.step ? "step" : undefined}
                className={cn(
                  "h-1 rounded-full transition-all",
                  step === props.step
                    ? "w-5 bg-foreground/60"
                    : "w-1 bg-foreground/15",
                )}
              />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1 className="mt-6 text-[22px] font-semibold tracking-[-0.015em]">
        {title}
      </h1>
      <p className="mt-2 text-balance text-[13.5px] leading-relaxed text-muted-foreground">
        {children}
      </p>
    </>
  );
}

function SignIn({
  onSignIn,
  onSubmitToken,
  signingIn,
  signInError,
  defaultShowToken,
  appUrl,
  appUrlPlaceholder,
  onAppUrlChange,
  onCancelSignIn,
}: OnboardingScreenProps) {
  const [showToken, setShowToken] = useState(defaultShowToken ?? false);
  const [token, setToken] = useState("");
  return (
    <>
      <EveryAppMark />
      <Heading title="Welcome to Every App">
        Start with Scribe: jot a few notes during the call, and Scribe listens
        and writes the rest when it ends.
      </Heading>
      {onAppUrlChange && (
        <input
          data-slot="app-url-input"
          aria-label="Scribe address"
          type="url"
          autoComplete="url"
          placeholder={appUrlPlaceholder}
          value={appUrl ?? ""}
          onChange={(event) => onAppUrlChange(event.target.value)}
          className="mt-8 h-8 w-full max-w-[280px] rounded-lg border border-input bg-card px-2.5 text-center text-[13px] outline-none focus:border-ring/50 focus:ring-3 focus:ring-ring/15"
        />
      )}
      <Button
        className={cn(
          "h-9 w-full max-w-[280px]",
          onAppUrlChange ? "mt-2" : "mt-8",
        )}
        onClick={onSignIn}
        pending={signingIn}
        disabled={onAppUrlChange ? !appUrl?.trim() : undefined}
      >
        {signingIn ? "Waiting for your browser…" : "Sign in with Every App"}
      </Button>
      {signingIn && onCancelSignIn && (
        <button
          type="button"
          onClick={onCancelSignIn}
          className="mt-2 text-[12px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      )}
      {signInError && (
        <p
          role="alert"
          className="mt-3 flex items-center gap-1.5 text-[12px] text-destructive"
        >
          <AlertCircle className="size-3.5" />
          {signInError}
        </p>
      )}
      {onSubmitToken && (
        <div className="mt-5 w-full max-w-[280px]">
          <button
            type="button"
            aria-expanded={showToken}
            onClick={() => setShowToken(!showToken)}
            className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
          >
            Paste a token instead
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                showToken && "rotate-180",
              )}
            />
          </button>
          {showToken && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (token.trim()) onSubmitToken(token.trim());
              }}
            >
              <input
                data-slot="token-input"
                aria-label="Access token"
                type="password"
                autoComplete="off"
                placeholder="Access token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-card px-2.5 text-[13px] outline-none focus:border-ring/50 focus:ring-3 focus:ring-ring/15"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                type="submit"
                disabled={!token.trim()}
              >
                Continue
              </Button>
            </form>
          )}
        </div>
      )}
    </>
  );
}

function Grant({ permissions, onGrant, onContinue }: OnboardingScreenProps) {
  const ready =
    permissions?.mic === "granted" && permissions.systemAudio === "granted";
  return (
    <>
      <EveryAppMark />
      <Heading title="Let Scribe hear the call">
        Every App only listens after you click record. Audio is transcribed as you go
        and never stored.
      </Heading>
      <ul className="mt-7 w-full divide-y divide-border overflow-hidden rounded-xl border border-border bg-card text-left">
        {(Object.keys(permissionInfo) as PermissionKind[]).map((kind) => {
          const info = permissionInfo[kind];
          return (
            <li key={kind} className="flex items-center gap-3 px-4 py-3">
              <info.icon className="size-4 shrink-0 text-foreground/55" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">
                  {info.title}
                  {kind === "notifications" && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · optional
                    </span>
                  )}
                </span>
                <span className="block text-[12px] text-muted-foreground">
                  {info.detail}
                </span>
              </span>
              <PermissionControl
                status={permissions?.[kind] ?? "undetermined"}
                onGrant={() => onGrant?.(kind)}
              />
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex items-center gap-3">
        {!ready && (
          <Button variant="ghost" size="sm" onClick={onContinue}>
            Skip for now
          </Button>
        )}
        <Button className="h-8 px-5" disabled={!ready} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </>
  );
}

function Done({ onFinish, accountName }: OnboardingScreenProps) {
  return (
    <>
      <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
        <Check className="size-6" />
      </span>
      <Heading
        title={
          accountName
            ? `You're set, ${accountName.split(" ")[0]}`
            : "You're set"
        }
      >
        Every App lives in your menu bar. It reminds you before meetings on your
        calendar, and asks before recording a call.
      </Heading>
      <Button className="mt-8 h-9 w-full max-w-[280px]" onClick={onFinish}>
        Open Every App
      </Button>
    </>
  );
}
