import { cn } from "cn";
import {
  Bell,
  CalendarDays,
  Mic,
  Monitor,
  Moon,
  Sun,
  Volume2,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "../components/ui/button";
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
import { ScreenBody, ScreenTitle } from "./parts";

export type CalendarConnection =
  | { state: "connected"; email: string | null }
  | { state: "disconnected"; reconnect: boolean }
  | { state: "unavailable" };

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
  /** The floating recorder in the screen's corner while recording (on by default); the switch
   * shows when given. */
  floatingRecorder?: boolean;
  onFloatingRecorderChange?: (on: boolean) => void;
  /** "Check microphone & Mac audio", under the permissions. */
  selfTest?: SelfTestProps;
  onConnectCalendar?: () => void;
  onLaunchAtLoginChange?: (on: boolean) => void;
  onDetectCallsChange?: (on: boolean) => void;
  onThemeChange?: (theme: ThemePreference) => void;
}

export function SettingsScreen(props: SettingsScreenProps) {
  return (
    <ScreenBody className="max-w-[640px]">
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
      <Section title="General">
        <Row
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
            title="Show the floating recorder while recording"
            detail="A small recorder in the corner of the screen, over your meeting. Hover over it to read the live transcript; click it to open the meeting."
            control={
              <Switch
                aria-label="Show the floating recorder while recording"
                checked={props.floatingRecorder}
                onCheckedChange={(on) => props.onFloatingRecorderChange?.(on)}
              />
            }
          />
        )}
        {props.recordShortcut !== undefined && (
          <Row
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
      <h2 className="mb-2 px-1 text-[12px] font-medium text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </div>
      {hint && (
        <p className="mt-2 px-1 text-[12px] text-muted-foreground">{hint}</p>
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
      {Icon && <Icon className="size-4 shrink-0 text-foreground/55" />}
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

function SkeletonRow() {
  return (
    <div aria-busy className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <Skeleton className="size-4 rounded" />
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

export const permissionInfo: Record<
  PermissionKind,
  { icon: ComponentType<{ className?: string }>; title: string; detail: string }
> = {
  mic: {
    icon: Mic,
    title: "Microphone",
    detail: "Your side of the call.",
  },
  systemAudio: {
    icon: Volume2,
    title: "System audio",
    detail: "Everyone else on the call, from your Mac's sound output.",
  },
  notifications: {
    icon: Bell,
    title: "Notifications",
    detail: 'Reminders before meetings, and "Record this call?".',
  },
};

export function PermissionControl({
  status,
  onGrant,
  onOpenSystemSettings,
  stuck = false,
}: {
  status: PermissionStatus;
  onGrant?: () => void;
  onOpenSystemSettings?: () => void;
  /** Asking didn't turn it on: offer System Settings instead of asking again. */
  stuck?: boolean;
}) {
  if (status === "granted") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-success" />
        Allowed
      </span>
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
