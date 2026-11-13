import { ArrowLeft, BookA, Mic } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../src/components/ui/button";
import type { ThemePreference } from "../src/lib/theme";
import {
  AppFrame,
  FloatingRecorder,
  type LiveLine,
  OfflineBanner,
  SignInAgainBanner,
  FolderScreen,
  HomeScreen,
  MeetingScreen,
  OnboardingScreen,
  SearchPalette,
  SearchScreen,
  SettingsScreen,
  SharedScreen,
  SidebarItem,
  SidebarSection,
  TemplatesScreen,
  WelcomeSplash,
  type LiveState,
  type MeetingPhase,
  type MeetingScreenProps,
  type OnboardingScreenProps,
  type SidebarProps,
  type TemplatesScreenProps,
  type TranscriptionTest,
} from "../src/screens";
import type {
  Levels,
  Loadable,
  MeetingDetail,
  NavTarget,
  SelfTestReport,
  SelfTestSide,
} from "../src/types";
// The app's own notice (the line at the bottom of the window), so a refused start is drawn with it.
import { Notice, notify } from "../../src/renderer/src/notice";
import * as mock from "./mocks";

export interface SceneContext {
  /** Move the meters and stream text (off for screenshots). */
  animate: boolean;
}

export interface Scene {
  id: string;
  group: string;
  label: string;
  render: (ctx: SceneContext) => ReactNode;
}

const ready = <T,>(data: T): Loadable<T> => ({ status: "ready", data });
const loading = { status: "loading" } as const;
const failed = (message: string) => ({ status: "error", message }) as const;

const noop = () => {};

/* Fake live data ---------------------------------------------------------- */

const STILL: Levels = { mic: 0.55, system: 0.8 };

function useLevels(animate: boolean): Levels {
  const [levels, setLevels] = useState(STILL);
  useEffect(() => {
    if (!animate) return;
    let t = 0;
    const timer = setInterval(() => {
      t += 1;
      const speaking = Math.floor(t / 30) % 2 === 0;
      setLevels({
        mic: speaking ? 0.08 * Math.random() : 0.3 + 0.6 * Math.random(),
        system: speaking ? 0.35 + 0.6 * Math.random() : 0.05 * Math.random(),
      });
    }, 100);
    return () => clearInterval(timer);
  }, [animate]);
  return levels;
}

function useStreamingText(full: string, animate: boolean): string {
  const words = full.split(" ");
  const [count, setCount] = useState(words.length);
  useEffect(() => {
    if (!animate) return;
    setCount(1);
    const timer = setInterval(
      () => setCount((n) => (n >= words.length ? 1 : n + 1)),
      220,
    );
    return () => clearInterval(timer);
  }, [animate, words.length]);
  return words.slice(0, count).join(" ");
}

function useElapsedMock(animate: boolean): number {
  const base = mock.NOW.getTime() - new Date(mock.liveStartedAt).getTime();
  const [extra, setExtra] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setExtra((n) => n + 1000), 1000);
    return () => clearInterval(timer);
  }, [animate]);
  return base + extra;
}

function useLive(animate: boolean): LiveState {
  const levels = useLevels(animate);
  const them = useStreamingText(mock.livePartial.them, animate);
  const elapsedMs = useElapsedMock(animate);
  return {
    recording: {
      meetingId: "m-live",
      title: "Northwind onboarding call",
      startedAt: mock.liveStartedAt,
      mode: "realtime",
      mic: "ok",
      system: "ok",
    },
    levels,
    partial: { me: "", them },
    elapsedMs,
  };
}

/* Frame ------------------------------------------------------------------- */

function Frame({
  current,
  children,
  titleBar,
  recording,
  folders = ready(mock.folders),
  banner,
  update,
  moreSections,
  account = mock.account,
}: {
  moreSections?: ReactNode;
  account?: typeof mock.account | null;
  current: NavTarget | null;
  children: ReactNode;
  titleBar?: ReactNode;
  /** This Mac is recording; `here` when the scene is the recording meeting's own page. */
  recording?: (Pick<LiveState, "recording" | "levels" | "elapsedMs"> & { here?: boolean; stopping?: boolean; status?: string; warning?: string }) | null;
  folders?: Loadable<typeof mock.folders>;
  banner?: ReactNode;
  update?: SidebarProps["update"];
}) {
  const sidebar: SidebarProps = {
    current,
    onNavigate: noop,
    folders,
    orgName: mock.account.orgName,
    account,
    onNewFolder: noop,
    onNewNote: noop,
    onSearch: noop,
    update,
    moreSections,
  };
  return (
    <AppFrame
      sidebar={sidebar}
      titleBar={titleBar}
      banner={banner}
      recorder={
        recording
          ? {
              recording: recording.recording,
              levels: recording.levels,
              elapsedMs: recording.elapsedMs,
              stopping: recording.stopping,
              here: recording.here ?? false,
              status: recording.status,
              warning: recording.warning,
              onOpen: noop,
              onTranscript: noop,
              onStop: noop,
            }
          : null
      }
    >
      {children}
    </AppFrame>
  );
}

function Breadcrumb({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
      <Button variant="ghost" size="icon-sm" aria-label="Back">
        <ArrowLeft />
      </Button>
      <span className="truncate">{children}</span>
    </div>
  );
}

/* Meeting ----------------------------------------------------------------- */

function MeetingScene({
  phase,
  meeting = mock.meeting,
  animate,
  extra,
  mode,
  elsewhere,
}: {
  phase: MeetingPhase;
  meeting?: MeetingDetail;
  animate: boolean;
  extra?: Partial<MeetingScreenProps>;
  /** "custom": the person's own transcription server. */
  mode?: LiveState["recording"]["mode"];
  /** This Mac is recording another meeting meanwhile. */
  elsewhere?: boolean;
}) {
  const base = useLive(animate);
  // Their own server sends finished text only: no turn still being typed out.
  const live: LiveState = mode
    ? {
        ...base,
        recording: { ...base.recording, mode },
        partial: mode === "custom" ? { me: "", them: "" } : base.partial,
      }
    : base;
  const [jottings, setJottings] = useState(
    phase === "before"
      ? "Agenda\n- recap the pilot\n- pricing for 40 seats\n- security review: who owns it?"
      : phase === "during"
        ? "- pilot went well, inbound team daily\n- SFDC sync?? ask eng about timeline\n- "
        : (meeting.jottings?.markdown ?? ""),
  );
  const shown: MeetingDetail =
    phase === "after"
      ? meeting
      : {
          ...meeting,
          id: "m-live",
          title: "Northwind onboarding call",
          status: "recording",
          notes: null,
          segments: phase === "during" ? mock.liveSegments : [],
          startsAt: mock.events[0]!.start,
          folders: [],
          template: {
            id: "customer-call",
            name: "Customer call",
            chosen: false,
          },
        };
  const recording =
    phase === "during" ? { ...live, here: true } : elsewhere ? live : null;
  return (
    <Frame
      current={null}
      recording={recording}
      titleBar={
        <Breadcrumb>{phase === "after" ? "Customer calls" : "Home"}</Breadcrumb>
      }
    >
      <MeetingScreen
        meeting={shown}
        phase={phase}
        jottings={jottings}
        onJottingsChange={setJottings}
        live={phase === "during" ? live : null}
        folders={mock.folders}
        templates={mock.templates}
        orgName={mock.account.orgName}
        onRetitle={noop}
        onStart={noop}
        onStop={noop}
        onSaveNotes={noop}
        onRetryNotes={noop}
        onChangeTemplate={noop}
        onToggleFolder={noop}
        onSetVisibility={noop}
        onCreateShareLink={noop}
        onRevokeShareLink={noop}
        onCopyShareLink={noop}
        shareUrl={(id) => `https://talk.every.app/s/${id}`}
        teamUrl="https://talk.every.app/meetings/5f0c2a9e-7b31-4d6a-9e58-2c41d0b7a913"
        onCopyTeamLink={() => true}
        onDelete={async () => {}}
        {...extra}
      />
    </Frame>
  );
}

/* Templates --------------------------------------------------------------- */

function TemplatesScene({
  recording,
  ...props
}: Partial<TemplatesScreenProps> & {
  initial?: string | "new" | null;
  /** This Mac is recording a meeting meanwhile. */
  recording?: SceneContext;
}) {
  const [selectedId, setSelectedId] = useState<string | "new" | null>(
    props.initial === undefined ? "t-1" : props.initial,
  );
  const live = useLive(recording?.animate ?? false);
  return (
    <Frame current={{ to: "templates" }} recording={recording ? live : null}>
      <TemplatesScreen
        templates={ready(mock.templates)}
        selectedId={selectedId}
        defaultTemplateId="general"
        orgName={mock.account.orgName}
        onSelect={setSelectedId}
        onNew={() => setSelectedId("new")}
        onSave={noop}
        onDelete={noop}
        onDuplicate={noop}
        onMakeDefault={noop}
        {...props}
      />
    </Frame>
  );
}

function SettingsScene({
  ownServer = false,
  filled = ownServer,
  savedKey = false,
  serverTest = { kind: "idle" },
}: {
  ownServer?: boolean;
  /** The address and model are saved. */
  filled?: boolean;
  savedKey?: boolean;
  serverTest?: TranscriptionTest;
}) {
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [launch, setLaunch] = useState(true);
  const [detect, setDetect] = useState(true);
  const [own, setOwn] = useState(ownServer);
  const [baseUrl, setBaseUrl] = useState(filled ? "http://localhost:50060/v1" : "");
  const [model, setModel] = useState(filled ? "large-v3" : "");
  const [keySaved, setKeySaved] = useState(savedKey);
  const [test, setTest] = useState<TranscriptionTest>(serverTest);
  const [baseUrlError, setBaseUrlError] = useState<string>();
  return (
    <SettingsScreen
      transcription={{
        enabled: own,
        baseUrl,
        model,
        keySaved,
        test,
        baseUrlError,
        onEnabledChange: setOwn,
        // The app's rule, roughly: plain http only to this Mac or the local network.
        onBaseUrlChange: (text) => {
          const refused = /^http:\/\/(?!localhost|127\.|10\.|192\.168\.|[^/]*\.local)/.test(text);
          setBaseUrlError(
            refused
              ? "Use an https address, or http for a server on this Mac or your local network."
              : undefined,
          );
          if (!refused) setBaseUrl(text);
        },
        onModelChange: setModel,
        onKeyChange: (key) => setKeySaved(!!key),
        onTest: () => setTest({ kind: "ok", ms: 640 }),
      }}
      account={ready(mock.account)}
      permissions={ready({ ...mock.permissionsMixed, systemAudio: "unknown" })}
      calendar={ready({ state: "connected", email: "ben@every.to" })}
      launchAtLogin={launch}
      detectCalls={detect}
      theme={theme}
      version="0.1.0 (alpha)"
      onSignOut={noop}
      onGrant={noop}
      onConnectCalendar={noop}
      onLaunchAtLoginChange={setLaunch}
      onDetectCallsChange={setDetect}
      onThemeChange={setTheme}
    />
  );
}

/** Copies of the desktop app's src/shared/setup.ts, for drawing. */
const SETUP_COMMANDS = {
  cli: "npm install -g everyapp",
  gateway: "everyapp setup",
  scribe: "everyapp install https://github.com/every-app/open-scribe",
};

function Onboarding(props: Partial<OnboardingScreenProps> & Pick<OnboardingScreenProps, "step">) {
  const [address, setAddress] = useState(props.address ?? "");
  return (
    <OnboardingScreen
      appName="Scribe"
      address={address}
      onAddressChange={setAddress}
      onConnect={noop}
      onSubmitToken={noop}
      setupCommands={SETUP_COMMANDS}
      onCopyCommand={noop}
      guideUrl="https://everyapp.com/docs/quickstart"
      onGrant={noop}
      onContinue={noop}
      onCheckAgain={noop}
      {...props}
    />
  );
}

/* Search ------------------------------------------------------------------ */

function PaletteScene({
  query: initial,
  offline,
}: {
  query: string;
  offline?: boolean;
}) {
  const [query, setQuery] = useState(initial);
  return (
    <Frame current={{ to: "home" }}>
      {home()}
      <SearchPalette
        open
        onOpenChange={noop}
        query={query}
        onQueryChange={setQuery}
        now={mock.NOW}
        results={
          !query.trim()
            ? { status: "idle" }
            : offline
              ? { status: "offline" }
              : ready({ results: mock.searchResults, hasMore: true })
        }
        onOpen={noop}
        onShowAll={noop}
      />
    </Frame>
  );
}

function SearchScene({
  query: initial,
  none,
  loading: busy,
  offline,
}: {
  query: string;
  none?: boolean;
  loading?: boolean;
  offline?: boolean;
}) {
  const [query, setQuery] = useState(initial);
  return (
    <Frame current={{ to: "search" }}>
      <SearchScreen
        query={query}
        onQueryChange={setQuery}
        now={mock.NOW}
        results={
          !query.trim()
            ? { status: "idle" }
            : offline
              ? { status: "offline" }
              : busy
                ? loading
                : ready({
                    results: none ? [] : mock.searchResults,
                    hasMore: !none,
                  })
        }
        onOpen={noop}
        onLoadMore={noop}
      />
    </Frame>
  );
}

type SelfTestVariant = "checking" | "ok" | "quiet" | "done";

function SelfTestScene({
  variant,
  animate = false,
}: {
  variant: SelfTestVariant;
  animate?: boolean;
}) {
  const live = useLevels(animate);
  const side: SelfTestSide = {
    status: "ok",
    peak: 0.42,
    clipping: false,
    clippedSamples: 0,
    dropouts: 0,
  };
  const mic: SelfTestSide = { ...side, device: "MacBook Pro Microphone" };
  const system: SelfTestSide = { ...side, device: "MacBook Pro Speakers" };
  const quietSystem: SelfTestSide = { ...system, status: "denied", peak: 0 };
  const report = (
    seconds: number,
    m: SelfTestSide,
    s: SelfTestSide,
  ): SelfTestReport => ({ seconds, passed: false, mic: m, system: s });
  const state =
    variant === "checking"
      ? {
          kind: "checking" as const,
          progress: report(1, { ...mic, status: "silent", peak: 0.1 }, quietSystem),
          levels: { mic: animate ? live.mic : 0.12, system: 0 },
        }
      : variant === "ok"
        ? {
            kind: "checking" as const,
            progress: report(4, mic, system),
            levels: animate ? live : { mic: 0.62, system: 0.48 },
          }
        : variant === "quiet"
          ? {
              kind: "checking" as const,
              progress: report(4, mic, quietSystem),
              levels: { mic: animate ? live.mic : 0.58, system: 0 },
            }
          : { kind: "done" as const, report: report(6, mic, quietSystem) };
  return (
    <Frame current={{ to: "settings" }}>
      <SettingsScreen
        account={ready(mock.account)}
        permissions={ready(mock.permissionsGranted)}
        calendar={ready({ state: "connected", email: "ben@every.to" })}
        launchAtLogin
        detectCalls
        theme="system"
        selfTest={{
          state,
          onStart: noop,
          onStop: noop,
          onOpenSettings: noop,
        }}
      />
    </Frame>
  );
}

/* Registry ---------------------------------------------------------------- */

const home = (overrides: Partial<Parameters<typeof HomeScreen>[0]> = {}) => (
  <HomeScreen
    comingUp={ready(mock.comingUp)}
    recent={ready(mock.recent)}
    onTakeNotes={noop}
    onOpenMeeting={noop}
    onConnectCalendar={noop}
    onNewNote={noop}
    onRetry={noop}
    now={mock.NOW}
    {...overrides}
  />
);

const folderScreen = (
  overrides: Partial<Parameters<typeof FolderScreen>[0]> = {},
) => (
  <FolderScreen
    folder={ready(mock.folders[0]!)}
    meetings={ready(mock.folderMeetings)}
    orgName={mock.account.orgName}
    templates={mock.templates}
    onOpenMeeting={noop}
    onRename={noop}
    onDelete={noop}
    onSetDefaultTemplate={noop}
    onRetry={noop}
    now={mock.NOW}
    {...overrides}
  />
);

/** Any page but the recording meeting's own, while this Mac records: the recorder bar stays. */
function Recording({
  animate,
  current,
  stopping,
  ownServer,
  status,
  warning,
  children,
}: SceneContext & {
  current: NavTarget | null;
  stopping?: boolean;
  /** The recording is on the person's own transcription server. */
  ownServer?: boolean;
  status?: string;
  warning?: string;
  children: ReactNode;
}) {
  const base = useLive(animate);
  const live = ownServer
    ? { ...base, recording: { ...base.recording, mode: "custom" as const } }
    : base;
  return (
    <Frame current={current} recording={{ ...live, stopping, status, warning }}>
      {children}
    </Frame>
  );
}

/* Floating recorder ------------------------------------------------------- */

/** The window main lays out (desktop/src/main/pill.ts): panel 292×342, pill 34×60 to its
 * right and 32 above its bottom, 5 apart, 4 of room around. */
const PILL_LAYOUT = {
  panel: { x: 4, y: 4, width: 292, height: 342 },
  pill: { x: 4 + 292 + 5, y: 4 + 342 - 32 - 60, width: 34, height: 60 },
};
const PILL_WINDOW = { width: 4 + 292 + 5 + 34 + 4, height: 4 + 342 + 4 };
/** Dragged to the screen's left edge, halfway up: the panel opens to the pill's right. */
const PILL_LAYOUT_LEFT = {
  panel: { x: 4 + 34 + 5, y: 4, width: 292, height: 342 },
  pill: { x: 4, y: 4 + 342 - 32 - 60, width: 34, height: 60 },
  panelSide: "right" as const,
};

function RecorderScene({
  expanded,
  animate,
  segments = mock.liveSegments,
  pending,
  stopping,
  notice,
  edge = "right",
}: {
  expanded: boolean;
  animate: boolean;
  /** The screen edge the pill is at: right until someone drags it to the left one. */
  edge?: "left" | "right";
  segments?: typeof mock.liveSegments;
  pending?: LiveLine[];
  stopping?: boolean;
  notice?: string;
}) {
  const levels = useLevels(animate);
  const them = useStreamingText(mock.livePartial.them, animate);
  // Main moves the real window (desktop/src/main/pillWindow.ts); here the scene stands in for
  // it, so the gesture can be tried: follow the pointer, then settle on the nearer side edge.
  const scene = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ edge: "left" | "right"; top?: number }>({
    edge,
    top: edge === "left" ? 120 : undefined,
  });
  const [held, setHeld] = useState<{ x: number; y: number }>();
  const [opened, setOpened] = useState(0);
  const follow = useRef<(e: PointerEvent) => void>(undefined);
  const layout = place.edge === "left" ? PILL_LAYOUT_LEFT : PILL_LAYOUT;
  const dragStart = (at: { x: number; y: number }) => {
    // `at` is in the page here; in the app the page is the recorder's window.
    const w = scene.current
      ?.querySelector("[data-recorder-window]")
      ?.getBoundingClientRect();
    const grab = { x: at.x - (w?.left ?? 0), y: at.y - (w?.top ?? 0) };
    follow.current = (e) => {
      const box = scene.current?.getBoundingClientRect();
      if (box)
        setHeld({
          x: e.clientX - box.left - grab.x,
          y: e.clientY - box.top - grab.y,
        });
    };
    window.addEventListener("pointermove", follow.current);
  };
  const dragEnd = () => {
    if (follow.current) window.removeEventListener("pointermove", follow.current);
    follow.current = undefined;
    const box = scene.current?.getBoundingClientRect();
    if (held && box) {
      const centre = held.x + layout.pill.x + layout.pill.width / 2;
      setPlace({
        edge: centre < box.width / 2 ? "left" : "right",
        top: Math.min(Math.max(held.y, 4), box.height - PILL_WINDOW.height - 4),
      });
    }
    setHeld(undefined);
  };
  return (
    // Something dark under it, like a full-screen call.
    <div
      ref={scene}
      data-theme="openseo-dark"
      className="relative h-full min-h-[600px] w-full overflow-hidden bg-[#14171c]"
    >
      <div className="absolute inset-x-0 top-0 p-6 font-mono text-[13px] text-neutral-500">
        A full-screen call or any app sits under the recorder. Drag the pill
        to move it; a click opens the meeting
        {opened > 0 && ` (clicked ${opened}×)`}.
      </div>
      <div
        className="absolute"
        data-recorder-window
        style={{
          ...PILL_WINDOW,
          ...(held
            ? { left: held.x, top: held.y }
            : {
                [place.edge]: 8 - 4,
                ...(place.top === undefined
                  ? { bottom: 8 - 4 }
                  : { top: place.top }),
              }),
        }}
      >
        <FloatingRecorder
          layout={layout}
          expanded={expanded && !held}
          level={stopping ? 0 : Math.max(levels.mic, levels.system)}
          stopping={stopping}
          segments={segments}
          pending={pending ?? [{ speaker: "them", text: them }]}
          notice={notice}
          animate={animate}
          onOpen={() => setOpened((n) => n + 1)}
          onDragStart={dragStart}
          onDragEnd={dragEnd}
        />
      </div>
    </div>
  );
}

/** The welcome splash over Home: held up for screenshots, coming and going otherwise. */
function WelcomeScene({ animate }: SceneContext) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (!animate) return;
    const timer = setTimeout(() => setShown((s) => !s), shown ? 1800 : 1200);
    return () => clearTimeout(timer);
  }, [shown, animate]);
  return (
    <div className="relative h-full w-full">
      <Frame current={{ to: "home" }}>{home()}</Frame>
      <WelcomeSplash contained shown={shown || !animate} />
    </div>
  );
}

/** The same window at Mission Control size: about a third, among other windows. */
function WelcomeThumbnail() {
  return (
    <div className="flex h-full w-full items-center justify-center gap-10 bg-[#1f3a5f] p-10">
      {[false, true].map((splash) => (
        <div
          key={String(splash)}
          className="relative h-[267px] w-[400px] shrink-0 overflow-hidden rounded-[6px] shadow-2xl ring-1 ring-black/30"
        >
          <div
            className="absolute left-0 top-0 h-[800px] w-[1200px]"
            style={{ zoom: 1 / 3 }}
          >
            <div className="relative h-full w-full">
              <Frame current={{ to: "home" }}>{home()}</Frame>
              {splash && <WelcomeSplash contained shown reducedMotion />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Home just after New note was refused: the app says why in its notice. */
function StartRefused({ text }: { text: string }) {
  useEffect(() => notify(text, "error"), [text]);
  return (
    <>
      <Frame current={{ to: "home" }}>{home()}</Frame>
      <Notice />
    </>
  );
}

export const scenes: Scene[] = [
  {
    id: "home",
    group: "Home",
    label: "Home",
    render: () => <Frame current={{ to: "home" }}>{home()}</Frame>,
  },
  {
    id: "home-recording",
    group: "Home",
    label: "Recording (bar on Home)",
    render: (ctx) => (
      <Recording {...ctx} current={{ to: "home" }}>
        {home()}
      </Recording>
    ),
  },
  {
    id: "home-recording-stopping",
    group: "Home",
    label: "Recording, finishing (bar on Home)",
    render: (ctx) => (
      <Recording {...ctx} current={{ to: "home" }} stopping>
        {home()}
      </Recording>
    ),
  },
  {
    id: "home-empty",
    group: "Home",
    label: "Empty (no calendar)",
    render: () => (
      <Frame current={{ to: "home" }}>
        {home({
          comingUp: ready({ state: "disconnected", reconnect: false }),
          recent: ready([]),
        })}
      </Frame>
    ),
  },
  {
    id: "sidebar-empty",
    group: "Sidebar",
    label: "No folders yet",
    render: () => (
      <Frame current={{ to: "home" }} folders={ready([])}>
        {home()}
      </Frame>
    ),
  },
  {
    id: "sidebar-loading",
    group: "Sidebar",
    label: "Folders loading, account not known yet",
    render: () => (
      <Frame current={{ to: "home" }} folders={loading} account={null}>
        {home()}
      </Frame>
    ),
  },
  {
    id: "sidebar-two-apps",
    group: "Sidebar",
    label: "With a second app (headings appear)",
    render: () => (
      <Frame
        current={{ to: "home" }}
        moreSections={
          <SidebarSection label="Dictation">
            <ul className="flex flex-col gap-px">
              <SidebarItem
                icon={Mic}
                label="History"
                target={{ to: "search" }}
                current={null}
                onNavigate={noop}
              />
              <SidebarItem
                icon={BookA}
                label="Dictionary"
                target={{ to: "search" }}
                current={null}
                onNavigate={noop}
              />
            </ul>
          </SidebarSection>
        }
      >
        {home()}
      </Frame>
    ),
  },
  {
    id: "home-offline",
    group: "Home",
    label: "Offline",
    render: () => (
      <Frame current={{ to: "home" }} banner={<OfflineBanner />}>
        {home()}
      </Frame>
    ),
  },
  {
    id: "home-signin-expired",
    group: "Home",
    label: "Sign-in expired",
    render: () => (
      <Frame
        current={{ to: "home" }}
        banner={
          <SignInAgainBanner kind="oauth" signingIn={false} onSignIn={noop} />
        }
      >
        {home()}
      </Frame>
    ),
  },
  {
    id: "home-update",
    group: "Home",
    label: "Update ready",
    render: () => (
      <Frame
        current={{ to: "home" }}
        update={{ version: "0.2.0", kind: "ready", onRestart: noop }}
      >
        {home()}
      </Frame>
    ),
  },
  {
    id: "home-update-after-stop",
    group: "Home",
    label: "Restart to update (after a recording)",
    render: () => (
      <Frame
        current={{ to: "home" }}
        update={{ version: "0.2.0", kind: "afterStop", onRestart: noop }}
      >
        {home()}
      </Frame>
    ),
  },
  {
    id: "home-loading",
    group: "Home",
    label: "Loading",
    render: () => (
      <Frame current={{ to: "home" }} folders={loading}>
        {home({ comingUp: loading, recent: loading })}
      </Frame>
    ),
  },
  {
    id: "home-error",
    group: "Home",
    label: "Error",
    render: () => (
      <Frame current={{ to: "home" }}>
        {home({
          comingUp: ready({
            state: "error",
            message: "Google Calendar didn't answer. Try again in a minute.",
          }),
          recent: failed("Couldn't reach Scribe. Check your connection."),
        })}
      </Frame>
    ),
  },

  {
    id: "meeting-before",
    group: "Meeting",
    label: "Before",
    render: (ctx) => <MeetingScene phase="before" {...ctx} />,
  },
  {
    id: "meeting-during",
    group: "Meeting",
    label: "During",
    render: (ctx) => <MeetingScene phase="during" {...ctx} />,
  },
  {
    id: "meeting-during-transcript",
    group: "Meeting",
    label: "During + transcript",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        {...ctx}
        extra={{ defaultTranscriptOpen: true }}
      />
    ),
  },
  {
    id: "meeting-during-reconnecting",
    group: "Meeting",
    label: "During, transcription reconnecting",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        {...ctx}
        extra={{ transcription: "reconnecting", defaultTranscriptOpen: true }}
      />
    ),
  },
  {
    id: "meeting-during-catching-up",
    group: "Meeting",
    label: "During, catching up",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        {...ctx}
        extra={{ transcription: "catching_up" }}
      />
    ),
  },
  {
    id: "meeting-stopping",
    group: "Meeting",
    label: "Stopping after an outage",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        {...ctx}
        extra={{
          transcription: "catching_up",
          stopping: true,
          stoppingMs: 47_000,
        }}
      />
    ),
  },
  {
    id: "meeting-during-warning",
    group: "Meeting",
    label: "During, slow connection",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        {...ctx}
        extra={{
          warning: "Connection is slow, some audio may be skipped.",
          warningDetail: "Their side: 3 chunks waiting to upload",
        }}
      />
    ),
  },
  {
    id: "meeting-own-server",
    group: "Meeting",
    label: "During, on your own transcription server",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        mode="custom"
        {...ctx}
        extra={{ defaultTranscriptOpen: true }}
      />
    ),
  },
  {
    id: "meeting-own-server-down",
    group: "Meeting",
    label: "During, your server isn't answering",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        mode="custom"
        {...ctx}
        extra={{ transcription: "own_server_down" }}
      />
    ),
  },
  {
    id: "meeting-own-server-down-transcript",
    group: "Meeting",
    label: "During, your server isn't answering + transcript",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        mode="custom"
        {...ctx}
        extra={{ transcription: "own_server_down", defaultTranscriptOpen: true }}
      />
    ),
  },
  {
    id: "meeting-own-server-dropped",
    group: "Meeting",
    label: "During, your server was down for over 5 minutes",
    render: (ctx) => (
      <MeetingScene
        phase="during"
        mode="custom"
        {...ctx}
        extra={{
          warning:
            "Your transcription server didn't answer for over 5 minutes, so the oldest audio from the wait was dropped.",
        }}
      />
    ),
  },
  {
    id: "meeting-stale-recording",
    group: "Meeting",
    label: "Left recording (yours)",
    render: (ctx) => (
      <MeetingScene
        phase="after"
        {...ctx}
        meeting={{ ...mock.meeting, status: "recording", notes: null }}
        extra={{ onFinish: () => {} }}
      />
    ),
  },
  {
    id: "meeting-recording-teammate",
    group: "Meeting",
    label: "Recording (a teammate's)",
    render: (ctx) => (
      <MeetingScene
        phase="after"
        {...ctx}
        meeting={{
          ...mock.meeting,
          status: "recording",
          notes: null,
          mine: false,
          ownerEmail: "ana@every.to",
          visibility: "team",
          jottings: null,
        }}
      />
    ),
  },
  {
    id: "meeting-processing",
    group: "Meeting",
    label: "Writing notes",
    render: (ctx) => (
      <MeetingScene
        phase="after"
        {...ctx}
        meeting={{ ...mock.meeting, status: "processing", notes: null }}
      />
    ),
  },
  {
    id: "meeting-after",
    group: "Meeting",
    label: "After: notes",
    render: (ctx) => <MeetingScene phase="after" {...ctx} />,
  },
  {
    id: "meeting-after-recording-another",
    group: "Meeting",
    label: "After, while recording another meeting",
    render: (ctx) => <MeetingScene phase="after" elsewhere {...ctx} />,
  },
  {
    id: "meeting-after-jottings",
    group: "Meeting",
    label: "After: jottings",
    render: (ctx) => (
      <MeetingScene phase="after" {...ctx} extra={{ defaultTab: "jottings" }} />
    ),
  },
  {
    id: "meeting-after-transcript",
    group: "Meeting",
    label: "After: transcript",
    render: (ctx) => (
      <MeetingScene
        phase="after"
        {...ctx}
        extra={{ defaultTab: "transcript" }}
      />
    ),
  },
  {
    id: "meeting-after-edit",
    group: "Meeting",
    label: "After: editing notes",
    render: (ctx) => (
      <MeetingScene phase="after" {...ctx} extra={{ defaultEditing: true }} />
    ),
  },
  {
    id: "meeting-share",
    group: "Meeting",
    label: "Share",
    render: (ctx) => (
      <MeetingScene
        phase="after"
        {...ctx}
        meeting={{
          ...mock.meeting,
          visibility: "team",
          shareLinks: [
            { id: "q8Zr2kTw4pXn", createdAt: mock.NOW.toISOString() },
          ],
        }}
        extra={{ defaultShareOpen: true }}
      />
    ),
  },
  {
    id: "meeting-share-private",
    group: "Meeting",
    label: "Share, private",
    render: (ctx) => (
      <MeetingScene
        phase="after"
        {...ctx}
        meeting={{ ...mock.meeting, visibility: "private", shareLinks: [] }}
        extra={{ defaultShareOpen: true }}
      />
    ),
  },
  {
    id: "meeting-failed",
    group: "Meeting",
    label: "Notes failed",
    render: (ctx) => (
      <MeetingScene
        phase="after"
        {...ctx}
        meeting={{ ...mock.meeting, status: "failed", notes: null }}
      />
    ),
  },

  {
    id: "search",
    group: "Search",
    label: "Results",
    render: () => <SearchScene query="pricing seat" />,
  },
  {
    id: "palette",
    group: "Search",
    label: "⌘K palette",
    render: () => <PaletteScene query="pricing seat" />,
  },
  {
    id: "palette-idle",
    group: "Search",
    label: "⌘K palette, empty",
    render: () => <PaletteScene query="" />,
  },
  {
    id: "palette-offline",
    group: "Search",
    label: "⌘K palette, offline",
    render: () => <PaletteScene query="pricing" offline />,
  },
  {
    id: "search-offline",
    group: "Search",
    label: "Page, offline",
    render: () => <SearchScene query="pricing" offline />,
  },
  {
    id: "search-idle",
    group: "Search",
    label: "Empty box",
    render: () => <SearchScene query="" />,
  },
  {
    id: "search-none",
    group: "Search",
    label: "No results",
    render: () => <SearchScene query="quarterly okr" none />,
  },
  {
    id: "search-loading",
    group: "Search",
    label: "Loading",
    render: () => <SearchScene query="pricing" loading />,
  },
  {
    id: "folder",
    group: "Folders",
    label: "Folder",
    render: () => (
      <Frame current={{ to: "folder", id: "f-1" }}>{folderScreen()}</Frame>
    ),
  },
  {
    id: "folder-team-empty",
    group: "Folders",
    label: "Team folder, empty",
    render: () => (
      <Frame current={{ to: "folder", id: "f-4" }}>
        {folderScreen({ folder: ready(mock.folders[3]!), meetings: ready([]) })}
      </Frame>
    ),
  },
  {
    id: "folder-loading",
    group: "Folders",
    label: "Loading",
    render: () => (
      <Frame current={{ to: "folder", id: "f-1" }}>
        {folderScreen({ folder: loading, meetings: loading })}
      </Frame>
    ),
  },
  {
    id: "folder-error",
    group: "Folders",
    label: "Error",
    render: () => (
      <Frame current={{ to: "folder", id: "f-1" }}>
        {folderScreen({
          folder: failed(
            "This folder was deleted or you no longer have access.",
          ),
        })}
      </Frame>
    ),
  },
  {
    id: "shared",
    group: "Folders",
    label: "Shared with me",
    render: () => (
      <Frame current={{ to: "shared" }}>
        <SharedScreen
          meetings={ready(mock.sharedMeetings)}
          orgName="Every"
          onOpenMeeting={noop}
          now={mock.NOW}
        />
      </Frame>
    ),
  },
  {
    id: "shared-empty",
    group: "Folders",
    label: "Shared, empty",
    render: () => (
      <Frame current={{ to: "shared" }}>
        <SharedScreen
          meetings={ready([])}
          orgName="Every"
          onOpenMeeting={noop}
          now={mock.NOW}
        />
      </Frame>
    ),
  },

  {
    id: "templates",
    group: "Templates",
    label: "Editor (mine)",
    render: () => <TemplatesScene />,
  },
  {
    id: "templates-recording",
    group: "Templates",
    label: "Recording (bar on Templates)",
    render: (ctx) => (
      <TemplatesScene recording={ctx} />
    ),
  },
  {
    id: "templates-builtin",
    group: "Templates",
    label: "Built-in",
    render: () => <TemplatesScene initial="general" />,
  },
  {
    id: "templates-new",
    group: "Templates",
    label: "New",
    render: () => <TemplatesScene initial="new" />,
  },
  {
    id: "templates-none",
    group: "Templates",
    label: "Nothing selected",
    render: () => <TemplatesScene initial={null} />,
  },
  {
    id: "templates-loading",
    group: "Templates",
    label: "Loading",
    render: () => <TemplatesScene templates={loading} />,
  },
  {
    id: "templates-error",
    group: "Templates",
    label: "Error",
    render: () => (
      <TemplatesScene
        templates={failed("Couldn't load templates. Check your connection.")}
      />
    ),
  },

  {
    id: "settings",
    group: "Settings",
    label: "Settings",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScene />
      </Frame>
    ),
  },
  {
    id: "settings-own-server-empty",
    group: "Settings",
    label: "Own transcription server: on, not filled in",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScene ownServer filled={false} />
      </Frame>
    ),
  },
  {
    id: "settings-own-server-filled",
    group: "Settings",
    label: "Own transcription server: filled in",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScene ownServer />
      </Frame>
    ),
  },
  {
    id: "settings-own-server-key",
    group: "Settings",
    label: "Own transcription server: API key saved",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScene ownServer savedKey serverTest={{ kind: "ok", ms: 640 }} />
      </Frame>
    ),
  },
  {
    id: "home-recording-own-server-down",
    group: "Home",
    label: "Recording, your server isn't answering (bar on Home)",
    render: (ctx) => (
      <Recording
        {...ctx}
        current={{ to: "home" }}
        ownServer
        status="Your transcription server isn't answering. Audio is kept for up to 5 minutes."
      >
        {home()}
      </Recording>
    ),
  },
  {
    id: "home-recording-own-server-dropped",
    group: "Home",
    label: "Recording, your server was down for over 5 minutes (bar on Home)",
    render: (ctx) => (
      <Recording
        {...ctx}
        current={{ to: "home" }}
        ownServer
        warning="Your transcription server didn't answer for over 5 minutes, so the oldest audio from the wait was dropped."
      >
        {home()}
      </Recording>
    ),
  },
  {
    id: "home-own-server-refused",
    group: "Home",
    label: "A recording refused: your server isn't answering",
    render: () => (
      <StartRefused text="Your transcription server at localhost:50060 isn't answering. Start it, or turn off your own server in Settings → Transcription." />
    ),
  },
  {
    id: "home-own-server-incomplete",
    group: "Home",
    label: "A recording refused: your server isn't set up",
    render: () => (
      <StartRefused text="Your own transcription server is on, but isn't set up. Add your transcription server's address in Settings → Transcription." />
    ),
  },
  {
    id: "settings-own-server",
    group: "Settings",
    label: "Own transcription server: tested",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScene ownServer serverTest={{ kind: "ok", ms: 640 }} />
      </Frame>
    ),
  },
  {
    id: "settings-own-server-down",
    group: "Settings",
    label: "Own transcription server: not answering",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScene
          ownServer
          serverTest={{
            kind: "error",
            message:
              "Your transcription server at localhost:50060 isn't answering.",
          }}
        />
      </Frame>
    ),
  },
  {
    id: "settings-recording",
    group: "Settings",
    label: "Recording (bar on Settings)",
    render: (ctx) => (
      <Recording {...ctx} current={{ to: "settings" }}>
        <SettingsScene />
      </Recording>
    ),
  },
  {
    id: "settings-permission-hint",
    group: "Settings",
    label: "Notifications still off",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScreen
          account={ready(mock.account)}
          permissions={ready({
            mic: "granted",
            systemAudio: "granted",
            notifications: "unknown",
          })}
          permissionHints={{
            notifications: "Allow notifications for Every App in System Settings.",
          }}
          onOpenSystemSettings={noop}
          calendar={ready({ state: "connected", email: "ben@every.to" })}
          launchAtLogin
          launchAtLoginHint="Allow Every App in System Settings → General → Login Items."
          detectCalls
          theme="system"
          onGrant={noop}
        />
      </Frame>
    ),
  },
  {
    id: "settings-selftest-checking",
    group: "Settings",
    label: "Audio check: just started",
    render: (ctx) => <SelfTestScene variant="checking" animate={ctx.animate} />,
  },
  {
    id: "settings-selftest-ok",
    group: "Settings",
    label: "Audio check: both sides working",
    render: (ctx) => <SelfTestScene variant="ok" animate={ctx.animate} />,
  },
  {
    id: "settings-selftest-quiet",
    group: "Settings",
    label: "Audio check: no sound from the Mac",
    render: (ctx) => <SelfTestScene variant="quiet" animate={ctx.animate} />,
  },
  {
    id: "settings-selftest-done",
    group: "Settings",
    label: "Audio check: stopped",
    render: () => <SelfTestScene variant="done" />,
  },
  {
    id: "settings-loading",
    group: "Settings",
    label: "Loading",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScreen
          account={loading}
          permissions={loading}
          calendar={loading}
          launchAtLogin={false}
          detectCalls={false}
          theme="system"
        />
      </Frame>
    ),
  },
  {
    id: "settings-disconnected",
    group: "Settings",
    label: "Calendar disconnected, errors",
    render: () => (
      <Frame current={{ to: "settings" }}>
        <SettingsScreen
          account={ready(mock.account)}
          permissions={failed("The audio helper isn't running. Restart Every App.")}
          calendar={ready({ state: "disconnected", reconnect: true })}
          launchAtLogin={false}
          detectCalls={true}
          theme="dark"
          onSignOut={noop}
          onConnectCalendar={noop}
        />
      </Frame>
    ),
  },

  {
    id: "onboarding-gateway",
    group: "Onboarding",
    label: "Connect your Gateway",
    render: () => <Onboarding step="gateway" />,
  },
  {
    id: "onboarding-setup",
    group: "Onboarding",
    label: "No Gateway yet? (opened)",
    render: () => <Onboarding step="gateway" address="apps.acme.com" defaultShowSetup copiedCommand="gateway" />,
  },
  {
    id: "onboarding-gateway-error",
    group: "Onboarding",
    label: "Not a Gateway",
    render: () => (
      <Onboarding
        step="gateway"
        address="acme.com"
        error="acme.com doesn't answer like an Every App Gateway. Check the address and try again."
      />
    ),
  },
  {
    id: "onboarding-waiting",
    group: "Onboarding",
    label: "Waiting for browser",
    render: () => <Onboarding step="gateway" address="apps.acme.com" connecting="browser" onCancelConnect={noop} />,
  },
  {
    id: "onboarding-token",
    group: "Onboarding",
    label: "Paste a token",
    render: () => <Onboarding step="gateway" address="http://talk.localhost:8787" defaultShowToken />,
  },
  {
    id: "onboarding-permissions-fresh",
    group: "Onboarding",
    label: "Permissions, fresh",
    render: () => <Onboarding step="permissions" permissions={mock.permissionsFresh} />,
  },
  {
    id: "onboarding-permissions",
    group: "Onboarding",
    label: "Permissions, system audio asked",
    render: () => (
      <Onboarding
        step="permissions"
        permissions={{ mic: "granted", systemAudio: "unknown", notifications: "undetermined" }}
        systemAudioAsked
      />
    ),
  },
  {
    id: "onboarding-permissions-blocked",
    group: "Onboarding",
    label: "Permissions, blocked",
    render: () => <Onboarding step="permissions" permissions={mock.permissionsMixed} />,
  },
  {
    id: "onboarding-add-app",
    group: "Onboarding",
    label: "Add Scribe",
    render: () => <Onboarding step="add-app" gatewayHost="apps.acme.com" />,
  },
  {
    id: "welcome-splash",
    group: "Onboarding",
    label: "Welcome splash",
    render: (ctx) => <WelcomeScene {...ctx} />,
  },
  {
    id: "welcome-splash-thumbnail",
    group: "Onboarding",
    label: "Welcome splash, Mission Control size",
    render: () => <WelcomeThumbnail />,
  },
  {
    id: "recorder-pill",
    group: "Floating recorder",
    label: "Pill (collapsed)",
    render: (ctx) => <RecorderScene expanded={false} animate={ctx.animate} />,
  },
  {
    id: "recorder-transcript",
    group: "Floating recorder",
    label: "Hovered: live transcript",
    render: (ctx) => <RecorderScene expanded animate={ctx.animate} />,
  },
  {
    id: "recorder-long",
    group: "Floating recorder",
    label: "Hovered: a long transcript, scrolled to the newest",
    render: (ctx) => (
      <RecorderScene
        expanded
        animate={ctx.animate}
        segments={mock.segments}
        pending={[{ speaker: "me", text: "Sounds good, I'll send the" }]}
      />
    ),
  },
  {
    id: "recorder-empty",
    group: "Floating recorder",
    label: "Hovered: nothing said yet",
    render: (ctx) => (
      <RecorderScene
        expanded
        animate={ctx.animate}
        segments={[]}
        pending={[]}
        notice="Starting…"
      />
    ),
  },
  {
    id: "recorder-own-server-down",
    group: "Floating recorder",
    label: "Hovered: your transcription server isn't answering",
    render: (ctx) => (
      <RecorderScene
        expanded
        animate={ctx.animate}
        pending={[]}
        notice="Your transcription server isn't answering. Your audio is kept."
      />
    ),
  },
  {
    id: "recorder-left",
    group: "Floating recorder",
    label: "Dragged to the left edge: the transcript opens on the right",
    render: (ctx) => (
      <RecorderScene expanded edge="left" animate={ctx.animate} />
    ),
  },
  {
    id: "recorder-stopping",
    group: "Floating recorder",
    label: "Hovered: finishing the transcript",
    render: (ctx) => (
      <RecorderScene
        expanded
        stopping
        animate={ctx.animate}
        pending={[]}
        notice="Finishing the transcript…"
      />
    ),
  },
];
