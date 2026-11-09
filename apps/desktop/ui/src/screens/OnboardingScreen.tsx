import { cn } from "cn";
import { AlertCircle, ArrowUpRight, Bell, Check, ChevronDown, Copy, Mic, RefreshCw, Volume2 } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import type { PermissionKind, Permissions, PermissionStatus } from "../types";
import { TITLE_BAR_HEIGHT, TitleBar } from "./AppFrame";

/**
 * First run: connect your Gateway, then permissions. When the Gateway answers but hasn't got
 * the app yet, one more step asks to install it (sign-in waits for it: a desktop sign-in is for
 * one app). The "Enjoy Every App" splash follows; it isn't drawn here.
 *
 * The window is two halves: Every App's brand panel on the left (always the brand's dark forest,
 * in both themes) and one job per screen on the right. The panel's headline and the right side's
 * heading start at the same height on every screen.
 */
export type OnboardingStep = "gateway" | "permissions" | "add-app";

/** Onboarding's setup commands, by id; the app copies them (the window can't write free text). */
export type SetupCommandId = "cli" | "gateway" | "scribe";

export interface OnboardingScreenProps {
  step: OnboardingStep;
  /** The feature onboarding is for, e.g. "Scribe". */
  appName: string;

  /* gateway */
  address?: string;
  onAddressChange?: (address: string) => void;
  onConnect?: () => void;
  /** "checking": looking at the address; "browser": waiting for the sign-in in the browser. */
  connecting?: "checking" | "browser" | null;
  onCancelConnect?: () => void;
  error?: string | null;
  onSubmitToken?: (token: string) => void;
  defaultShowToken?: boolean;
  setupCommands?: Record<SetupCommandId, string>;
  onCopyCommand?: (id: SetupCommandId) => void;
  copiedCommand?: SetupCommandId | null;
  guideUrl?: string;
  /** Open "No Gateway yet?" from the start (the playground). */
  defaultShowSetup?: boolean;

  /* permissions */
  permissions?: Permissions;
  /** System audio was asked for: macOS can't report the grant, so this is as far as we know. */
  systemAudioAsked?: boolean;
  onGrant?: (kind: PermissionKind) => void;
  onTestSound?: () => void;
  testingSound?: boolean;
  onContinue?: () => void;
  onLater?: () => void;

  /* add-app */
  gatewayHost?: string;
  onCheckAgain?: () => void;
  checking?: boolean;
}

/** The Every App mark (the pine tree). Bundled: the window's CSP allows 'self' and data: images. */
const MARK_URL = new URL("../assets/everyapp-mark.png", import.meta.url).href;

export function EveryAppLogo({ className }: { className?: string }) {
  return (
    <img
      src={MARK_URL}
      alt="Every App"
      draggable={false}
      className={cn("size-11 rounded-[26%] shadow-[0_0_0_0.5px_rgb(0_0_0/0.25)]", className)}
    />
  );
}

/** Every App's brand colour, the landing page's background. The panel keeps it in both themes. */
const FOREST = "#0a0f0d";
/** Where both halves start their text: the panel's optical centre, a little above the middle. */
const TOP = "27vh";
/** The step label above the heading, so the heading (not the label) lines up with the panel's headline. */
const EYEBROW = 28;

const H2 = "text-[24px] font-semibold leading-tight tracking-[-0.022em]";
const LEAD = "mt-2 text-[14px] leading-relaxed text-muted-foreground";
/** Primary buttons: Mac-sized, and quiet while disabled. */
const PRIMARY = "h-9 px-4 text-[13px] disabled:bg-foreground/[0.08] disabled:text-foreground/35 disabled:opacity-100";

const PROMISES = ["Hosted in your own cloud.", "Shared with participants.", "Secured by Cloudflare's network."];

export function OnboardingScreen(props: OnboardingScreenProps) {
  const eyebrow = props.step === "add-app" ? "One more thing" : `Step ${props.step === "gateway" ? 1 : 2} of 2`;
  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <BrandPanel appName={props.appName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar />
        <div
          className="flex min-h-0 flex-1 justify-center overflow-y-auto px-10 pb-12 min-[1100px]:px-14"
          style={{ paddingTop: `max(16px, calc(${TOP} - ${TITLE_BAR_HEIGHT + EYEBROW}px))` }}
        >
          <div className="w-full max-w-[400px]">
            <p className="mb-2.5 h-[18px] text-[12px] font-medium tabular-nums text-muted-foreground">{eyebrow}</p>
            {props.step === "gateway" &&
              (props.connecting === "browser" ? <Browser {...props} /> : <Connect {...props} />)}
            {props.step === "permissions" && <Grant {...props} />}
            {props.step === "add-app" && <AddApp {...props} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* The brand panel ------------------------------------------------------------------- */

function BrandPanel({ appName }: { appName: string }) {
  return (
    <aside
      aria-label="Every App"
      className="drag-region flex w-[34%] min-w-[300px] max-w-[400px] shrink-0 flex-col border-r border-white/[0.06] px-10 pb-9 text-stone-300 min-[1100px]:px-12"
      style={{ background: FOREST, paddingTop: TOP }}
    >
      {/* The top is left to the window's traffic lights. */}
      <p className="text-[32px] font-semibold leading-[1.04] tracking-[-0.032em] text-white min-[1100px]:text-[40px]">
        Private
        <br />
        meeting notes.
      </p>
      <ul className="mt-6 space-y-1 text-[14px] leading-[1.6] text-stone-400 min-[1100px]:text-[15px]">
        {PROMISES.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      {/* One row when there's room; in a narrow window the line about more apps goes under the mark. */}
      <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pt-6">
        <EveryAppLogo className="size-[22px] rounded-[6px] shadow-[0_0_0_0.5px_rgb(255_255_255/0.16)]" />
        <span className="whitespace-nowrap text-[13px] font-semibold text-stone-300">Every App</span>
        <span className="basis-full text-[12px] text-stone-500 min-[1100px]:ml-auto min-[1100px]:basis-auto">
          {appName} today. More apps soon.
        </span>
      </div>
    </aside>
  );
}

/* Pieces -------------------------------------------------------------------------- */

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-left text-[12.5px] leading-snug text-destructive">
      <AlertCircle className="mt-px size-3.5 shrink-0" />
      {children}
    </p>
  );
}

/** A setup command: one line that scrolls, with a copy button. */
function Command({
  id,
  text,
  copied,
  onCopy,
}: {
  id: SetupCommandId;
  text: string;
  copied?: boolean;
  onCopy?: (id: SetupCommandId) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background pl-3 pr-1.5 dark:bg-black/20">
      <code
        data-selectable
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2 font-mono text-[12px] [mask-image:linear-gradient(to_right,black_88%,transparent)] [scrollbar-width:none]"
      >
        <span className="select-none text-muted-foreground/60">$ </span>
        {text}
      </code>
      {onCopy && (
        <button
          type="button"
          aria-label={copied ? "Copied" : `Copy ${text}`}
          onClick={() => onCopy(id)}
          className={cn(
            "inline-flex shrink-0 items-center rounded-md p-1 transition-colors",
            copied ? "text-success" : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      )}
    </div>
  );
}

function LinkOut({ href, children }: { href?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60"
    >
      {children}
      <ArrowUpRight className="size-3.5" />
    </a>
  );
}

/* Connect your Gateway ------------------------------------------------------------------ */

function Connect({
  appName,
  address = "",
  onAddressChange,
  onConnect,
  connecting,
  error,
  onSubmitToken,
  defaultShowToken,
  setupCommands,
  onCopyCommand,
  copiedCommand,
  guideUrl,
  defaultShowSetup,
}: OnboardingScreenProps) {
  const [showToken, setShowToken] = useState(defaultShowToken ?? false);
  const [showSetup, setShowSetup] = useState(defaultShowSetup ?? false);
  const [token, setToken] = useState("");
  // The field shows "https://" itself; a pasted https:// is dropped. Plain http (local
  // development) is kept as typed and the prefix hides.
  const plainHttp = address.startsWith("http://");
  const steps: { id: SetupCommandId; title: string }[] = [
    { id: "cli", title: "Install the Every App CLI" },
    { id: "gateway", title: "Set up your Gateway" },
    { id: "scribe", title: `Add ${appName} to it` },
  ];
  return (
    <>
      <h1 className={H2}>Connect your Gateway</h1>
      <p className={LEAD}>The address you sign in to Every App with.</p>
      <form
        className="mt-7"
        onSubmit={(event) => {
          event.preventDefault();
          if (address.trim() && !connecting) onConnect?.();
        }}
      >
        <div className="flex gap-2">
          <div
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center rounded-lg border bg-card pl-3 text-[13.5px] shadow-xs focus-within:border-ring/50 focus-within:ring-3 focus-within:ring-ring/15 dark:shadow-none",
              error ? "border-destructive/60 ring-3 ring-destructive/12" : "border-input",
            )}
          >
            {!plainHttp && <span className="select-none text-muted-foreground/70">https://</span>}
            <input
              id="gateway-address"
              aria-label="Your Gateway address"
              data-slot="gateway-address-input"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="apps.yourcompany.com"
              value={address}
              disabled={!!connecting}
              onChange={(event) => onAddressChange?.(event.target.value.replace(/^https:\/\//i, ""))}
              className="h-full min-w-0 flex-1 bg-transparent pr-3 outline-none placeholder:text-muted-foreground/45"
            />
          </div>
          <Button type="submit" className={PRIMARY} disabled={!address.trim()} pending={connecting === "checking"}>
            {connecting === "checking" ? "Checking" : "Continue"}
          </Button>
        </div>
        {error ? (
          <ErrorLine>{error}</ErrorLine>
        ) : (
          <p className="mt-2.5 text-[12.5px] text-muted-foreground">Your browser opens next to confirm it's you.</p>
        )}
      </form>

      {setupCommands && (
        <section className="mt-7">
          <button
            type="button"
            aria-expanded={showSetup}
            onClick={() => setShowSetup(!showSetup)}
            className="inline-flex items-center gap-1 text-left text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <span>
              <span className="font-medium text-foreground">No Gateway yet?</span> Set one up in about 15 minutes
            </span>
            <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", showSetup && "rotate-180")} />
          </button>
          {showSetup && (
            <div className="mt-4 border-l border-border pl-4">
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                You need Cloudflare's Workers Paid plan ($5 a month) and a domain on Cloudflare.
              </p>
              <ol className="mt-4 space-y-3.5">
                {steps.map((s, i) => (
                  <li key={s.id}>
                    <p className="mb-1.5 text-[12.5px] font-medium">
                      <span className="mr-1.5 tabular-nums text-muted-foreground">{i + 1}.</span>
                      {s.title}
                    </p>
                    <Command id={s.id} text={setupCommands[s.id]} copied={copiedCommand === s.id} onCopy={onCopyCommand} />
                  </li>
                ))}
              </ol>
              <p className="mt-4 text-[12px] text-muted-foreground">
                Then enter its address above.{guideUrl && " "}
                {guideUrl && <LinkOut href={guideUrl}>Full guide</LinkOut>}
              </p>
            </div>
          )}
        </section>
      )}

      {onSubmitToken && (
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={showToken}
            onClick={() => setShowToken(!showToken)}
            className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
          >
            Paste a token instead
            <ChevronDown className={cn("size-3 transition-transform", showToken && "rotate-180")} />
          </button>
          {showToken && (
            <form
              className="mt-2 flex gap-2"
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
              <Button size="sm" variant="outline" className="h-8" type="submit" disabled={!token.trim() || !address.trim()}>
                Continue
              </Button>
            </form>
          )}
        </div>
      )}
    </>
  );
}

function Browser({ address, onCancelConnect, error }: OnboardingScreenProps) {
  return (
    <>
      <h1 className={H2}>Finish in your browser</h1>
      <p className={LEAD}>
        Sign in to {address || "your Gateway"} if it asks, then select{" "}
        <span className="font-medium text-foreground">Allow</span>. You'll come straight back here.
      </p>
      {error && <ErrorLine>{error}</ErrorLine>}
      {onCancelConnect && (
        <Button variant="outline" className="mt-7 h-9 px-4 text-[13px]" onClick={onCancelConnect}>
          Cancel
        </Button>
      )}
    </>
  );
}

/* Permissions --------------------------------------------------------------------------- */

const permissionRows: {
  kind: PermissionKind;
  icon: ComponentType<{ className?: string }>;
  title: string;
  detail: (appName: string) => string;
  optional?: boolean;
}[] = [
  { kind: "mic", icon: Mic, title: "Microphone", detail: () => "Your side of the call." },
  {
    kind: "systemAudio",
    icon: Volume2,
    title: "System audio",
    detail: (appName) => `Everyone else, from your Mac's sound output. ${appName} takes the sound, never the screen.`,
  },
  {
    kind: "notifications",
    icon: Bell,
    title: "Notifications",
    detail: () => 'A nudge before meetings, and "Record this call?".',
    optional: true,
  },
];

/** What a row shows: system audio that was asked for but can't be confirmed is "asked". */
type RowStatus = PermissionStatus | "asked";

function rowStatus(kind: PermissionKind, permissions: Permissions | undefined, systemAudioAsked: boolean): RowStatus {
  const status = permissions?.[kind] ?? "undetermined";
  if (kind === "systemAudio" && systemAudioAsked && (status === "unknown" || status === "undetermined")) return "asked";
  return status;
}

function Grant({
  appName,
  permissions,
  systemAudioAsked = false,
  onGrant,
  onTestSound,
  testingSound,
  onContinue,
  onLater,
}: OnboardingScreenProps) {
  const statuses = Object.fromEntries(
    permissionRows.map((r) => [r.kind, rowStatus(r.kind, permissions, systemAudioAsked)]),
  ) as Record<PermissionKind, RowStatus>;
  const next = permissionRows.find((r) => statuses[r.kind] === "undetermined" || statuses[r.kind] === "unknown")?.kind;
  const ready = statuses.mic === "granted" && (statuses.systemAudio === "granted" || statuses.systemAudio === "asked");
  return (
    <>
      <h1 className={H2}>Let {appName} listen</h1>
      <p className={LEAD}>Only after you press record, and it asks before recording a call. macOS confirms each one.</p>
      <ul className="mt-7 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {permissionRows.map((row) => {
          const status = statuses[row.kind];
          return (
            <li key={row.kind} className="flex items-center gap-3.5 px-4 py-3.5">
              <row.icon
                className={cn("size-[17px] shrink-0", status === "granted" ? "text-success" : "text-foreground/60")}
              />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[13px] font-medium">
                  {row.title}
                  {row.optional && <span className="font-normal text-muted-foreground"> · recommended</span>}
                </span>
                <span className="block text-[12px] leading-snug text-muted-foreground">
                  {status === "asked"
                    ? `Allowed in macOS? ${appName} confirms it the first time it hears your Mac play sound.`
                    : row.detail(appName)}
                </span>
              </span>
              <PermissionAction
                status={status}
                isNext={row.kind === next}
                onGrant={() => onGrant?.(row.kind)}
                onTestSound={onTestSound}
                testingSound={testingSound}
              />
            </li>
          );
        })}
      </ul>
      <div className="mt-7 flex items-center gap-4">
        <Button className={PRIMARY} disabled={!ready} onClick={onContinue}>
          Continue
        </Button>
        {!ready && (
          <button
            type="button"
            onClick={onLater ?? onContinue}
            className="text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            Set up later in Settings
          </button>
        )}
      </div>
    </>
  );
}

function PermissionAction({
  status,
  isNext,
  onGrant,
  onTestSound,
  testingSound,
}: {
  status: RowStatus;
  isNext: boolean;
  onGrant: () => void;
  onTestSound?: () => void;
  testingSound?: boolean;
}) {
  if (status === "granted") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-success">
        <Check className="size-3.5" /> Allowed
      </span>
    );
  }
  if (status === "asked") {
    return onTestSound ? (
      <Button size="sm" variant="outline" className="shrink-0" onClick={onTestSound} pending={testingSound}>
        {testingSound ? "Listening" : "Play a test sound"}
      </Button>
    ) : null;
  }
  if (status === "denied") {
    return (
      <span className="inline-flex shrink-0 items-center gap-3">
        <span className="text-[12px] text-destructive">Blocked</span>
        <Button size="sm" variant="outline" onClick={onGrant}>
          Open System Settings
        </Button>
      </span>
    );
  }
  return (
    <Button size="sm" variant={isNext ? "default" : "outline"} className="shrink-0 px-3" onClick={onGrant}>
      Allow
    </Button>
  );
}

/* One more thing, only when needed: the Gateway hasn't got the app yet -------------------- */

function AddApp({
  appName,
  gatewayHost,
  setupCommands,
  onCopyCommand,
  copiedCommand,
  onCheckAgain,
  checking,
  error,
  guideUrl,
}: OnboardingScreenProps) {
  return (
    <>
      <h1 className={H2}>Add {appName} to your Gateway</h1>
      <p className={LEAD}>
        {gatewayHost ?? "Your Gateway"} is connected, but {appName} isn't on it yet. Install it there so your
        transcripts stay in your own cloud, ready to share with your team and the people in the meeting.
      </p>
      {setupCommands && (
        <>
          <p className="mb-2 mt-7 text-[12.5px] font-medium">Run this where you set up the Gateway</p>
          <Command id="scribe" text={setupCommands.scribe} copied={copiedCommand === "scribe"} onCopy={onCopyCommand} />
        </>
      )}
      <p className="mt-2.5 text-[12px] text-muted-foreground">
        Didn't set it up? Send this to whoever runs your Gateway.
        {guideUrl && " "}
        {guideUrl && <LinkOut href={guideUrl}>Guide</LinkOut>}
      </p>
      {error && <ErrorLine>{error}</ErrorLine>}
      <Button className={cn("mt-8", PRIMARY)} onClick={onCheckAgain} pending={checking}>
        {checking ? (
          "Checking your Gateway"
        ) : (
          <>
            <RefreshCw className="size-3.5" /> I've installed it
          </>
        )}
      </Button>
    </>
  );
}
