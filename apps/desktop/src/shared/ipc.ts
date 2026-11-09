// The typed bridge between the renderer and main. The preload exposes `window.everyapp` with exactly
// these calls; main registers a handler for each `invoke` channel and validates its arguments.

import type { SetupCommandId } from "./setup";
import type { HelperEvent, PermissionStatus, ChannelHealth, SelfTestReport, TranscriptionState } from "./protocol";

export type { SelfTestReport, SelfTestSide } from "./protocol";
import type { CalendarEvent, Me, MeetingDetail, MeetingPatch, MeetingSummary } from "./api";
import type { Segment } from "./contract";
import type { Speaker } from "./protocol";

export type TrayState = "idle" | "recording" | "attention";

export type ThemePreference = "system" | "light" | "dark";

/** The app's settings, kept by main in userData/settings.json. */
export interface Settings {
  /** Open Every App when you log in (a macOS login item). */
  launchAtLogin: boolean;
  /** Ask "Record this call?" when a call app starts using the mic (the helper's `detect.set`). */
  callDetection: boolean;
  /** How many minutes before a meeting the reminder comes, 0–30. */
  reminderLeadMinutes: number;
  /** Applied as nativeTheme.themeSource, so prefers-color-scheme follows it. */
  theme: ThemePreference;
  /** A global shortcut, ⌃⌥⌘R, that starts or stops a recording from anywhere. Off by default. */
  recordShortcut: boolean;
  /** The floating recorder: a small pill in the screen's bottom-right corner while recording,
   * which shows the live transcript on hover. On by default. */
  floatingRecorder: boolean;
}

export type SettingsPatch = Partial<Settings>;

export const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: false,
  callDetection: true,
  reminderLeadMinutes: 1,
  theme: "system",
  recordShortcut: false,
  floatingRecorder: true,
};

export const MAX_REMINDER_LEAD_MINUTES = 30;

/** "verified": a system-audio tap has delivered sound at least once. macOS has no API to read this
 * permission, so the helper answers "unknown" until then. */
export type SystemAudioStatus = "granted" | "denied" | "undetermined" | "verified" | "unknown";

export interface PermissionsSnapshot {
  mic: PermissionStatus;
  systemAudio: SystemAudioStatus;
  /** "granted" or "denied" once a notification has been shown or refused; "unknown" before. */
  notifications: PermissionStatus;
}

export type PermissionKind = "mic" | "systemAudio" | "notifications";

export interface LoginItemSnapshot {
  /** "requiresApproval": macOS wants the person to allow it in System Settings → General → Login
   * Items. "unsupported": an unpackaged dev run, which macOS won't register. */
  status: "enabled" | "disabled" | "requiresApproval" | "unsupported";
}

export interface AuthSnapshot {
  status: "signedOut" | "signingIn" | "signedIn";
  method?: "oauth" | "token";
  appUrl?: string;
  email?: string;
  orgName?: string;
  /** Why the last sign-in or API call failed, in words for a person. */
  error?: string;
  /** Cloudflare Access stopped a token-only request: the person must use Sign in with Every App. */
  needsEveryAppSignIn?: boolean;
  /** Signed out because the session ended (refresh refused, 401 after refresh), not by choice.
   * `appUrl` and `method` are kept so the window can offer "Sign in again" in place. */
  expired?: boolean;
}

/** Updates (only in a build with a feed). "ready": downloaded, waiting for "Restart to Update".
 * `deferred`: a restart was asked for during a recording; it's offered again after Stop. */
export interface UpdateSnapshot {
  enabled: boolean;
  state: "idle" | "checking" | "downloading" | "ready" | "upToDate" | "error";
  version?: string;
  /** 0–1 while downloading. */
  progress?: number;
  deferred?: boolean;
  error?: string;
  lastCheck?: string;
}

/** Pushed once when an update has downloaded. */
export interface UpdateReadyEvent {
  state: "ready";
  version: string;
}

/** Whether Every App can reach its app. "signin-needed": the sign-in expired or Cloudflare Access wants
 * a login (see `auth.expired`, `auth.needsEveryAppSignIn`). */
export type Connection = "online" | "offline" | "signin-needed";

export interface HelperSnapshot {
  status: "stopped" | "starting" | "ready" | "restarting" | "unavailable";
  version?: string;
  macos?: string;
  restarts: number;
  /** Unexpected exits since launch (a crash, whether or not it was recording). */
  crashes: number;
  lastError?: string;
  permissions?: { mic: PermissionStatus; systemAudio: PermissionStatus };
}

export interface RecordingSnapshot {
  state: "idle" | "starting" | "recording" | "stopping";
  meetingId?: string;
  calendarEventId?: string;
  title?: string;
  startedAt?: string;
  mode?: "realtime" | "fallback";
  mic?: ChannelHealth;
  system?: ChannelHealth;
  /** "reconnecting": transcription can't be reached (the audio is kept, up to 5 minutes);
   * "catching_up": that kept audio is being transcribed now, live audio goes on. */
  transcription?: TranscriptionState;
  /** Something the person should know that doesn't stop the recording (e.g. the fallback upload
   * fell behind and dropped some audio: helper error `fallback_backlog`). */
  warning?: string;
  /** True from Stop until the helper has saved everything; can take minutes after an outage
   * (it transcribes the audio kept meanwhile). `stoppingSince` (ISO) gives the elapsed time. */
  stopping?: boolean;
  stoppingSince?: string;
  /** The live transcript's last finished line. */
  lastLine?: string;
  error?: string;
}

export interface CalendarSnapshot {
  connected: boolean;
  connectUrl?: string;
  events: CalendarEvent[];
  error?: string;
  lastRefresh?: string;
}

export interface AppSnapshot {
  version: string;
  auth: AuthSnapshot;
  helper: HelperSnapshot;
  recording: RecordingSnapshot;
  calendar: CalendarSnapshot;
  tray: TrayState;
  updater: UpdateSnapshot;
  /** A self-test is running: recording can't start until it ends. */
  selfTest: { running: boolean };
  /** The optional global shortcut (⌃⌥⌘R): "conflict" when another app holds it. */
  recordShortcut: "off" | "on" | "conflict";
  settings: Settings;
  connection: Connection;
  permissions: PermissionsSnapshot;
  loginItem: LoginItemSnapshot;
}

export interface StartRecordingRequest {
  title?: string;
  calendarEventId?: string;
  /** Also open the event's call link. */
  join?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the floating recorder's window draws (src/main/pill.ts). Pushed on the "pill" channel
 * when it changes; the meters come as `levels` events on the "helper" channel. */
export interface PillView {
  /** The mouse is over the pill (or the open panel): show the live transcript. */
  expanded: boolean;
  /** Where the panel and the pill sit, in the window's own coordinates. The window covers both
   * all the time; only the pill takes the mouse until the panel opens. */
  layout: { panel: Rect; pill: Rect };
  recording: Pick<RecordingSnapshot, "state" | "title" | "startedAt" | "stoppingSince" | "transcription">;
  /** The newest turns (bounded) while expanded; empty while collapsed. In memory only. */
  transcript: { segments: Segment[]; pending: { speaker: Speaker; text: string }[] };
}

/** Where the first screen's address leads (src/main/auth/locate.ts). */
export type Located =
  /** Sign in to `appUrl`. */
  | { kind: "app"; appUrl: string; gatewayUrl?: string }
  /** A Gateway answered, but the app isn't on it yet. `appUrl` is where it will be. */
  | { kind: "missing"; gatewayUrl: string; appUrl: string };

/** `invoke` channels: name → [args, result]. */
export interface InvokeMap {
  "state:get": [[], AppSnapshot];
  /** The first screen: a Gateway's address or the app's own, to the app to sign in to (or where it
   * will be, when the Gateway hasn't got it yet). Reads only public sign-in metadata. */
  "auth:locate": [[text: string], Located];
  "auth:signIn": [[appUrl: string], void];
  "auth:cancelSignIn": [[], void];
  "auth:signInWithToken": [[appUrl: string, token: string], void];
  "auth:signOut": [[], void];
  "recording:start": [[request: StartRecordingRequest], void];
  "recording:stop": [[], void];
  /** @deprecated use "permissions:request". */
  "helper:requestPermission": [[kind: "mic" | "systemAudio"], void];
  "permissions:get": [[], PermissionsSnapshot];
  "permissions:request": [[kind: PermissionKind], PermissionsSnapshot];
  "permissions:openSettings": [[pane: PermissionKind], void];
  "settings:get": [[], Settings];
  "settings:set": [[patch: SettingsPatch], Settings];
  "calendar:refresh": [[], void];
  "calendar:connect": [[], void];
  "api:me": [[], Me];
  "api:meetings": [[], MeetingSummary[]];
  "api:meeting": [[id: string], MeetingDetail];
  "api:updateMeeting": [[id: string, patch: MeetingPatch], MeetingSummary];
  "app:openInBrowser": [[meetingId?: string], void];
  /** One /api/v1 call from the window, allowlisted in main (src/main/api/routes.ts). */
  "api:call": [[method: ApiMethod, path: string, opts?: ApiCallOptions], unknown];
  /** Copy a link (https, or the app's own origin; ≤ 2 KB): the sandboxed window can't. */
  "clipboard:writeText": [[text: string], void];
  /** Copy one of onboarding's setup commands (src/shared/setup.ts), by id: main holds the text. */
  "clipboard:copySetup": [[id: SetupCommandId], void];
  /** Settings → "Check microphone & Mac audio": a local capture until `selftest:stop` (60 s at
   * most; the helper's selftest.run). `levels` (0–1, 10 Hz) and `selftest.progress` (the report
   * so far, each second) arrive on the "helper" channel meanwhile; it answers the last report.
   * Refused while recording; a recording can't start meanwhile. */
  "selftest:run": [[], SelfTestReport];
  /** Ends the running check, if any (selftest:run then answers). */
  "selftest:stop": [[], void];
  /** Restart into a downloaded update; during a recording it's deferred until Stop. */
  "update:install": [[], { deferred: boolean }];
  /** The floating recorder's window: its current view. */
  "pill:get": [[], PillView];
  /** A click on the floating recorder: the main window, on the recording's meeting. */
  "pill:openMeeting": [[], void];
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiCallOptions {
  query?: Record<string, string>;
  body?: unknown;
}

export type InvokeChannel = keyof InvokeMap;

/** Pushes from main: name → payload. */
/** Main asks the window to show a screen (the app menu's Settings…, later the tray). The renderer
 * validates it before navigating. */
export type NavigateRequest = { to: "settings" } | { to: "home" } | { to: "meeting"; meetingId: string };

export interface EventMap {
  state: AppSnapshot;
  helper: HelperEvent;
  navigate: NavigateRequest;
  update: UpdateReadyEvent;
  pill: PillView;
}

export type EventChannel = keyof EventMap;

export type DesktopBridge = {
  [C in InvokeChannel]: (...args: InvokeMap[C][0]) => Promise<InvokeMap[C][1]>;
} & {
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void;
};

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  "state:get",
  "auth:locate",
  "auth:signIn",
  "auth:cancelSignIn",
  "auth:signInWithToken",
  "auth:signOut",
  "recording:start",
  "recording:stop",
  "helper:requestPermission",
  "permissions:get",
  "permissions:request",
  "permissions:openSettings",
  "settings:get",
  "settings:set",
  "calendar:refresh",
  "calendar:connect",
  "api:me",
  "api:meetings",
  "api:meeting",
  "api:updateMeeting",
  "app:openInBrowser",
  "api:call",
  "clipboard:writeText",
  "clipboard:copySetup",
  "update:install",
  "selftest:run",
  "pill:get",
  "pill:openMeeting",
  "selftest:stop",
] as const;

export const EVENT_CHANNELS: readonly EventChannel[] = ["state", "helper", "navigate", "update", "pill"] as const;
