import { cn } from "cn";
import {
  AudioLines,
  Bell,
  CalendarDays,
  Keyboard,
  Mic,
  Monitor,
  Moon,
  Palette,
  PhoneIncoming,
  PictureInPicture2,
  Power,
  Sun,
  TimerOff,
  Volume2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import type { ThemePreference } from "../lib/theme";
import type {
  Account,
  Loadable,
  PermissionKind,
  Permissions,
  PermissionStatus,
} from "../types";
import { Avatar } from "./AppFrame";
import { SelfTest, type SelfTestProps } from "./SelfTest";
import { ROW_LEAD, ScreenBody, ScreenTitle, SectionLabel } from "./parts";

export type CalendarConnection =
  | { state: "connected"; email: string | null }
  | { state: "disconnected"; reconnect: boolean }
  | { state: "unavailable" };

/** Settings → Transcription → Test: the last answer from the person's own server. */
export type TranscriptionTest =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; ms: number }
  | { kind: "error"; message: string };

/** The person's own OpenAI-compatible transcription server. */
export interface TranscriptionSettingsProps {
  enabled: boolean;
  /** The saved address and model ("" when not set). */
  baseUrl: string;
  model: string;
  /** An API key is saved (it is never shown). */
  keySaved: boolean;
  /** Why the address just typed wasn't saved. */
  baseUrlError?: string;
  test: TranscriptionTest;
  onEnabledChange?: (on: boolean) => void;
  /** Called when a field is left or Enter is pressed, with the trimmed text. */
  onBaseUrlChange?: (text: string) => void;
  onModelChange?: (text: string) => void;
  /** "" removes the saved key. */
  onKeyChange?: (key: string) => void;
  onTest?: () => void;
}

export const TRANSCRIPTION_HINT =
  "With your own server, meeting audio goes only to it, never to OpenAI or to Scribe. The transcript text still goes to Scribe, and Scribe's AI model writes the notes from it. The transcript arrives every 20 to 30 seconds instead of word by word.";

export interface SettingsScreenProps {
  account: Loadable<Account>;
  permissions: Loadable<Permissions>;
  calendar: Loadable<CalendarConnection>;
  launchAtLogin: boolean;
  detectCalls: boolean;
  theme: ThemePreference;
  version?: string;
  /** Under "Open at login", e.g. when macOS wants it approved. */
  launchAtLoginHint?: string;
  onSignOut?: () => void;
  onGrant?: (kind: PermissionKind) => void;
  /** Open that permission's pane in System Settings. */
  onOpenSystemSettings?: (kind: PermissionKind) => void;
  /** Shown under a permission when asking didn't turn it on (it then offers System Settings). */
  permissionHints?: Partial<Record<PermissionKind, string>>;
  /** The global ⌃⌥⌘R record shortcut (off by default); the switch shows when given. */
  recordShortcut?: boolean;
  /** "conflict": another app holds ⌃⌥⌘R, so Every App couldn't take it. */
  recordShortcutStatus?: "off" | "on" | "conflict";
  onRecordShortcutChange?: (on: boolean) => void;
  /** The floating recorder in the screen's corner while recording and the window isn't in front
   * (on by default); the switch shows when given. */
  floatingRecorder?: boolean;
  onFloatingRecorderChange?: (on: boolean) => void;
  /** "Still recording?" for a recording that looks forgotten (on by default); the switch shows
   * when given. */
  autoStop?: boolean;
  onAutoStopChange?: (on: boolean) => void;
  /** "Check microphone & Mac audio", under the permissions. */
  selfTest?: SelfTestProps;
  /** The person's own transcription server; the section shows when given. */
  transcription?: TranscriptionSettingsProps;
  onConnectCalendar?: () => void;
  onLaunchAtLoginChange?: (on: boolean) => void;
  onDetectCallsChange?: (on: boolean) => void;
  onThemeChange?: (theme: ThemePreference) => void;
}

export function SettingsScreen(props: SettingsScreenProps) {
  return (
    <ScreenBody>
      <ScreenTitle>Settings</ScreenTitle>
      <Section title="Account">
        <AccountRow {...props} />
      </Section>
      <Section
        title="Permissions"
        hint="Scribe records only after you click record. Audio is transcribed and never stored."
      >
        <Permissions {...props} />
        {props.selfTest && <SelfTest {...props.selfTest} />}
      </Section>
      <Section title="Calendar">
        <CalendarRow {...props} />
      </Section>
      {props.transcription && (
        <Section title="Transcription" hint={TRANSCRIPTION_HINT}>
          <TranscriptionServer {...props.transcription} />
        </Section>
      )}
      <Section title="General">
        <Row
          icon={Power}
          title="Open at login"
          detail={
            props.launchAtLoginHint ? (
              <span className="text-warning-foreground dark:text-warning">
                {props.launchAtLoginHint}
              </span>
            ) : (
              "Keep Every App in the menu bar so calendar reminders reach you."
            )
          }
          control={
            <Switch
              aria-label="Open at login"
              checked={props.launchAtLogin}
              onCheckedChange={(on) => props.onLaunchAtLoginChange?.(on)}
            />
          }
        />
        <Row
          icon={PhoneIncoming}
          title="Ask to record calls"
          detail="When Zoom, Meet, Teams or Slack starts a call, Scribe asks first. It never records on its own."
          control={
            <Switch
              aria-label="Ask to record calls"
              checked={props.detectCalls}
              onCheckedChange={(on) => props.onDetectCallsChange?.(on)}
            />
          }
        />
        {props.floatingRecorder !== undefined && (
          <Row
            icon={PictureInPicture2}
            title="Show the floating recorder while recording"
            detail="A small recorder in the corner of the screen, over your meeting, whenever this window isn't in front. Hover over it to read the live transcript, click it to open the meeting, and drag it to move it."
            control={
              <Switch
                aria-label="Show the floating recorder while recording"
                checked={props.floatingRecorder}
                onCheckedChange={(on) => props.onFloatingRecorderChange?.(on)}
              />
            }
          />
        )}
        {props.autoStop !== undefined && (
          <Row
            icon={TimerOff}
            title="Stop a recording I forgot"
            detail="When the other side goes quiet or the meeting is over, Scribe asks “Still recording?” and stops if nobody answers. The transcript and notes are kept."
            control={
              <Switch
                aria-label="Stop a recording I forgot"
                checked={props.autoStop}
                onCheckedChange={(on) => props.onAutoStopChange?.(on)}
              />
            }
          />
        )}
        {props.recordShortcut !== undefined && (
          <Row
            icon={Keyboard}
            title={
              <>
                Record shortcut{" "}
                <kbd className="ml-1 rounded border border-border px-1 font-sans text-[11px] font-normal text-muted-foreground">
                  ⌃⌥⌘R
                </kbd>
              </>
            }
            detail={
              props.recordShortcut &&
              props.recordShortcutStatus === "conflict" ? (
                <span className="text-warning-foreground dark:text-warning">
                  Another app is using ⌃⌥⌘R, so Every App can't. Change it there,
                  then turn this off and on again.
                </span>
              ) : (
                "Start or stop a recording from any app."
              )
            }
            control={
              <Switch
                aria-label="Record shortcut"
                checked={props.recordShortcut}
                onCheckedChange={(on) => props.onRecordShortcutChange?.(on)}
              />
            }
          />
        )}
        <Row
          icon={Palette}
          title="Appearance"
          control={
            <ThemePicker value={props.theme} onChange={props.onThemeChange} />
          }
        />
      </Section>
      {props.version && (
        <p className="-mt-4 text-center text-[11px] text-muted-foreground">
          Every App {props.version}
        </p>
      )}
    </ScreenBody>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <SectionLabel>{title}</SectionLabel>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </div>
      {hint && (
        <p className="mt-2 text-[12px] text-muted-foreground">{hint}</p>
      )}
    </section>
  );
}

function Row({
  icon: Icon,
  title,
  detail,
  control,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  detail?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <span className={ROW_LEAD}>
        {Icon && <Icon className="size-4 text-foreground/55" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        {detail && (
          <div className="text-[12px] text-muted-foreground">{detail}</div>
        )}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  );
}

/** A text field that saves when it's left or Enter is pressed, and follows the saved value. */
function SavedField({
  label,
  value,
  placeholder,
  type = "text",
  error,
  clearOnSave = false,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  type?: "text" | "password";
  error?: string;
  /** For a secret: once saved, the field empties instead of showing it. */
  clearOnSave?: boolean;
  onSave?: (text: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => {
    const text = draft.trim();
    if (text !== value) onSave?.(text);
    if (clearOnSave) setDraft("");
  };
  return (
    <div className="flex items-start gap-3 px-4 py-2">
      <span className={ROW_LEAD} />
      <label
        htmlFor={id}
        className="w-28 shrink-0 pt-1.5 text-[13px] text-foreground/80"
      >
        {label}
      </label>
      <div className="min-w-0 flex-1">
        <Input
          id={id}
          type={type}
          value={draft}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          className="h-8 text-[13px] md:text-[13px]"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {error && (
          <p role="alert" className="mt-1 text-[12px] text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function TranscriptionServer(props: TranscriptionSettingsProps) {
  const { test } = props;
  const incomplete = !props.baseUrl || !props.model;
  return (
    <>
      <Row
        icon={AudioLines}
        title="Use my own transcription server"
        detail="Send meeting audio to an OpenAI-compatible server you run, such as a Whisper server on this Mac, instead of to OpenAI."
        control={
          <Switch
            aria-label="Use my own transcription server"
            checked={props.enabled}
            onCheckedChange={(on) => props.onEnabledChange?.(on)}
          />
        }
      />
      {props.enabled && (
        <div className="py-1.5">
          <SavedField
            label="Server address"
            value={props.baseUrl}
            placeholder="http://localhost:50060/v1"
            error={props.baseUrlError}
            onSave={props.onBaseUrlChange}
          />
          <SavedField
            label="Model"
            value={props.model}
            placeholder="The model name your server expects"
            onSave={props.onModelChange}
          />
          <SavedField
            label="API key"
            type="password"
            value=""
            clearOnSave
            placeholder={
              props.keySaved
                ? "Saved. Type a new key to replace it"
                : "Optional. Most local servers need none"
            }
            onSave={(key) => key && props.onKeyChange?.(key)}
          />
          <div className="flex min-h-10 items-center gap-3 px-4 py-1.5">
            <span className={ROW_LEAD} />
            <Button
              size="sm"
              variant="outline"
              disabled={incomplete || test.kind === "testing"}
              onClick={props.onTest}
            >
              {test.kind === "testing" ? "Testing…" : "Test"}
            </Button>
            {props.keySaved && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => props.onKeyChange?.("")}
              >
                Remove API key
              </Button>
            )}
            <p
              role="status"
              className={cn(
                "min-w-0 flex-1 text-[12px]",
                test.kind === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {test.kind === "ok" && (
                <>
                  <span className="mr-1.5 inline-block size-1.5 rounded-full bg-success align-middle" />
                  Your server answered in {(test.ms / 1000).toFixed(1)} s.
                </>
              )}
              {test.kind === "error" && test.message}
              {test.kind === "idle" && incomplete && (
                <span className="text-warning-foreground dark:text-warning">
                  Add the server address and model. Until then a recording
                  won't start.
                </span>
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function SkeletonRow() {
  return (
    <div aria-busy className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <span className={ROW_LEAD}>
        <Skeleton className="size-4 rounded" />
      </span>
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="ml-auto h-6 w-16" />
    </div>
  );
}

function AccountRow({ account, onSignOut }: SettingsScreenProps) {
  if (account.status === "loading") return <SkeletonRow />;
  if (account.status === "error") {
    return <Row title="Couldn't load your account" detail={account.message} />;
  }
  const { name, email, orgName } = account.data;
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Avatar name={name} className="size-9 text-[12px]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{name}</div>
        <div className="truncate text-[12px] text-muted-foreground">
          {email} · {orgName}
        </div>
      </div>
      {onSignOut && (
        <Button variant="outline" size="sm" onClick={onSignOut}>
          Sign out
        </Button>
      )}
    </div>
  );
}

/** Each permission's name and one line about it, in Settings and in onboarding alike. */
export const permissionInfo: Record<
  PermissionKind,
  {
    icon: ComponentType<{ className?: string }>;
    title: string;
    detail?: string;
    /** macOS can't report it: until a recording proves it, Settings only opens its pane. */
    unreadable?: boolean;
  }
> = {
  mic: { icon: Mic, title: "Microphone", detail: "Record your side of the conversation." },
  systemAudio: { icon: Volume2, title: "System audio", detail: "Record meeting participants' audio.", unreadable: true },
  notifications: { icon: Bell, title: "Notifications", detail: "Get notified before meetings." },
};

export function PermissionControl({
  status,
  onGrant,
  onOpenSystemSettings,
  stuck = false,
  unreadable = false,
}: {
  status: PermissionStatus;
  onGrant?: () => void;
  onOpenSystemSettings?: () => void;
  /** Asking didn't turn it on: offer System Settings instead of asking again. */
  stuck?: boolean;
  /** macOS can't report it, so don't claim it's off: just open its pane. */
  unreadable?: boolean;
}) {
  if (status === "granted") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-success" />
        Allowed
      </span>
    );
  }
  if (unreadable && status !== "denied" && onOpenSystemSettings) {
    return (
      <Button size="sm" variant="outline" onClick={onOpenSystemSettings}>
        View in Settings
      </Button>
    );
  }
  if (stuck && onOpenSystemSettings) {
    return (
      <Button size="sm" variant="outline" onClick={onOpenSystemSettings}>
        Open System Settings
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-3">
      {status === "denied" && (
        <span className="text-[12px] text-destructive">Blocked</span>
      )}
      <Button
        size="sm"
        variant={status === "denied" ? "outline" : "default"}
        onClick={onGrant}
      >
        {status === "denied" ? "Open Settings" : "Grant"}
      </Button>
    </span>
  );
}

function Permissions({
  permissions,
  onGrant,
  onOpenSystemSettings,
  permissionHints,
}: SettingsScreenProps) {
  if (permissions.status === "loading") {
    return (
      <>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </>
    );
  }
  if (permissions.status === "error") {
    return (
      <Row title="Couldn't check permissions" detail={permissions.message} />
    );
  }
  return (
    <>
      {(Object.keys(permissionInfo) as PermissionKind[]).map((kind) => {
        const info = permissionInfo[kind];
        return (
          <Row
            key={kind}
            icon={info.icon}
            title={info.title}
            detail={
              permissionHints?.[kind] &&
              permissions.data[kind] !== "granted" ? (
                <>
                  {info.detail}
                  <span
                    role="status"
                    className="mt-0.5 block text-warning-foreground dark:text-warning"
                  >
                    {permissionHints[kind]}
                  </span>
                </>
              ) : (
                info.detail
              )
            }
            control={
              <PermissionControl
                status={permissions.data[kind]}
                onGrant={() => onGrant?.(kind)}
                onOpenSystemSettings={() => onOpenSystemSettings?.(kind)}
                stuck={!!permissionHints?.[kind]}
                unreadable={info.unreadable}
              />
            }
          />
        );
      })}
    </>
  );
}

function CalendarRow({ calendar, onConnectCalendar }: SettingsScreenProps) {
  if (calendar.status === "loading") return <SkeletonRow />;
  if (calendar.status === "error") {
    return (
      <Row
        icon={CalendarDays}
        title="Google Calendar"
        detail={calendar.message}
      />
    );
  }
  const data = calendar.data;
  if (data.state === "unavailable") {
    return (
      <Row
        icon={CalendarDays}
        title="Google Calendar"
        detail="Not set up on this workspace. An admin adds Google to the Every App Gateway."
      />
    );
  }
  if (data.state === "connected") {
    return (
      <Row
        icon={CalendarDays}
        title="Google Calendar"
        detail={data.email ? `Connected as ${data.email}` : "Connected"}
        control={
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            Connected
          </span>
        }
      />
    );
  }
  return (
    <Row
      icon={CalendarDays}
      title="Google Calendar"
      detail={
        data.reconnect
          ? "The connection expired. Reconnect to see upcoming meetings."
          : "See upcoming meetings and get a reminder before each one."
      }
      control={
        <Button size="sm" onClick={onConnectCalendar}>
          {data.reconnect ? "Reconnect" : "Connect"}
        </Button>
      }
    />
  );
}

const themes: {
  value: ThemePreference;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange?: (theme: ThemePreference) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="inline-flex rounded-lg bg-foreground/[0.06] p-0.5"
    >
      {themes.map((theme) => (
        <button
          key={theme.value}
          type="button"
          role="radio"
          aria-checked={value === theme.value}
          onClick={() => onChange?.(theme.value)}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors",
            value === theme.value
              ? "bg-card font-medium text-foreground shadow-xs"
              : "text-foreground/60 hover:text-foreground",
          )}
        >
          <theme.icon className="size-3" />
          {theme.label}
        </button>
      ))}
    </div>
  );
}
