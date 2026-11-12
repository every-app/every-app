// The window: sign-in and first-run permissions until they're done, then the app frame around
// the routed page, with "Enjoy Every App" over it while the window is out of sight (splash.ts).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AppSnapshot, Located } from "@shared/ipc";
import type { NavTarget, PermissionKind, SetupCommandId, Space } from "@every-app/desktop-ui";
import { SCRIBE } from "@shared/features";
import { GATEWAY_GUIDE_URL, SETUP_COMMANDS } from "@shared/setup";
import { AppFrame, OfflineBanner, OnboardingScreen, SignInAgainBanner, SPLASH_TIMING, TitleBar, WelcomeSplash } from "@every-app/desktop-ui";
import { useRecordingElapsed } from "../useRecordingElapsed";
import { Button } from "@every-app/desktop-ui/components/button";
import { clearDrafts, useCancelledStart, useFollowRecording, useStartRecording, useStopRecording } from "../actions";
import { api, cleanError, keys } from "../api";
import { grantPermission, newNoteBlockedReason, uiPermissions } from "../settings-logic";
import { cameBackOnline, connectionOf, gateOf, signInAgainOf, type Gate, type Snapshot } from "../connection";
import { retryUnsavedJottings } from "../jottings";
import { installUpdate, rememberDeferred, updatePillOf } from "../update";
import { useLevels } from "../live";
import { splashShownOf } from "../splash";
import { useWindowAway } from "../useSplash";
import { accountFrom, loadable } from "../map";
import { notify } from "../notice";
import { bridge, useAppState } from "../bridge";

const ONBOARDED_KEY = "everyapp.onboarded";

// Only needed when someone adds a folder: keep Base UI's dialog out of the first chunk.
const NameDialog = lazy(() => import("../dialogs").then((m) => ({ default: m.NameDialog })));
// ⌘K: loaded the first time it opens.
const Palette = lazy(() => import("../Palette").then((m) => ({ default: m.Palette })));

export function Root() {
  const state = useAppState();
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem(ONBOARDED_KEY) === "1");
  // An expired sign-in keeps the app on screen (see connection.ts); only a real sign-out leaves.
  const gateRef = useRef<Gate>("loading");
  const gate = gateOf(state, gateRef.current);
  gateRef.current = gate;
  if (!state) return <TitleBar />;
  const finishOnboarding = () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    setOnboarded(true);
  };
  // Signed out: the Gateway first. When the Gateway hasn't got the app yet, permissions and
  // "add the app" come before the sign-in (which needs the app), all on this screen.
  if (gate === "welcome") return <Welcome state={state} onboarded={onboarded} onPermissionsDone={finishOnboarding} />;
  // Signed in for the first time: permissions, then straight to the home page.
  if (!onboarded) return <FirstRun state={state} onDone={finishOnboarding} />;
  return (
    <>
      <Layout state={state} />
      <Splash state={state} />
    </>
  );
}

function Splash({ state }: { state: AppSnapshot }) {
  const away = useWindowAway(SPLASH_TIMING.awayDelay);
  return <WelcomeSplash shown={splashShownOf({ away, recording: state.recording.state })} />;
}

/** The address field's first value: the last app signed in to, shown as its Gateway when it's at
 * `<appId>.<gateway host>` (the field takes either). */
function addressFrom(appUrl: string | undefined): string {
  if (!appUrl) return "";
  try {
    const url = new URL(appUrl);
    const prefix = `${SCRIBE.backend.appId}.`;
    const host = url.host.startsWith(prefix) ? url.host.slice(prefix.length) : url.host;
    return url.protocol === "http:" ? `http://${host}` : host;
  } catch {
    return "";
  }
}

/** A command's copy button: copied for two seconds. */
function useCopyCommand() {
  const [copied, setCopied] = useState<SetupCommandId | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = useCallback((id: SetupCommandId) => {
    bridge["clipboard:copySetup"](id).then(
      () => setCopied(id),
      (e: unknown) => notify(cleanError(e), "error"),
    );
  }, []);
  return { copied, copy };
}

/** The permissions step's state and actions, before or after the sign-in. */
function usePermissionsStep(state: AppSnapshot) {
  const permissions = uiPermissions(state.permissions);
  const [systemAudioAsked, setSystemAudioAsked] = useState(false);
  const onGrant = (kind: PermissionKind) => {
    if (kind === "systemAudio") setSystemAudioAsked(true);
    void grantPermission(bridge, kind, permissions[kind]).then(
      // System audio that isn't reported either way is "asked" on the row, not an error.
      ({ hint, status }) => hint && !(kind === "systemAudio" && (status === "unknown" || status === "undetermined")) && notify(hint),
      (e: unknown) => notify(cleanError(e), "error"),
    );
  };
  return { permissions, systemAudioAsked, onGrant };
}

function Welcome({
  state,
  onboarded,
  onPermissionsDone,
}: {
  state: AppSnapshot;
  onboarded: boolean;
  onPermissionsDone: () => void;
}) {
  // Signed out: before-call drafts belong to the account that wrote them.
  useEffect(() => clearDrafts(), []);
  const [step, setStep] = useState<"gateway" | "permissions" | "add-app">("gateway");
  const [address, setAddress] = useState(() => addressFrom(state.auth.appUrl));
  const [missing, setMissing] = useState<Extract<Located, { kind: "missing" }> | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyCommand();
  const grant = usePermissionsStep(state);
  const signingIn = state.auth.status === "signingIn";

  const signIn = (appUrl: string) => bridge["auth:signIn"](appUrl).catch((e: unknown) => setError(cleanError(e)));

  const connect = async () => {
    setError(null);
    setChecking(true);
    try {
      const found = await bridge["auth:locate"](address.trim());
      if (found.kind === "app") {
        setChecking(false);
        await signIn(found.appUrl);
        return;
      }
      setMissing(found);
      setStep(onboarded ? "add-app" : "permissions");
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setChecking(false);
    }
  };

  const checkAgain = async () => {
    if (!missing) return;
    setError(null);
    setChecking(true);
    try {
      const found = await bridge["auth:locate"](missing.gatewayUrl);
      if (found.kind === "app") {
        setChecking(false);
        await signIn(found.appUrl);
      } else {
        setError(`${SCRIBE.label} isn't on ${new URL(missing.gatewayUrl).host} yet. Install it, then check again.`);
      }
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setChecking(false);
    }
  };

  const shownError = error ?? state.auth.error ?? null;
  return (
    <OnboardingScreen
      step={step}
      appName={SCRIBE.label}
      address={address}
      onAddressChange={(next) => {
        setAddress(next);
        setError(null);
      }}
      onConnect={() => void connect()}
      connecting={checking ? "checking" : signingIn ? "browser" : null}
      onCancelConnect={() => void bridge["auth:cancelSignIn"]()}
      error={shownError}
      onSubmitToken={(token) =>
        void bridge["auth:locate"](address.trim())
          .then((found) => found.appUrl, () => address.trim())
          .then((appUrl) => bridge["auth:signInWithToken"](appUrl, token))
          .catch((e: unknown) => setError(cleanError(e)))
      }
      setupCommands={SETUP_COMMANDS}
      onCopyCommand={copy}
      copiedCommand={copied}
      guideUrl={GATEWAY_GUIDE_URL}
      {...grant}
      onContinue={() => {
        onPermissionsDone();
        setStep("add-app");
      }}
      gatewayHost={missing ? new URL(missing.gatewayUrl).host : undefined}
      onCheckAgain={() => void checkAgain()}
      checking={checking || signingIn}
    />
  );
}

function FirstRun({ state, onDone }: { state: AppSnapshot; onDone: () => void }) {
  const grant = usePermissionsStep(state);
  return <OnboardingScreen step="permissions" appName={SCRIBE.label} {...grant} onContinue={onDone} />;
}

function navFrom(pathname: string): NavTarget | null {
  if (pathname === "/") return { to: "home" };
  if (pathname === "/shared") return { to: "shared" };
  if (pathname === "/search") return { to: "search" };
  if (pathname === "/templates") return { to: "templates" };
  if (pathname === "/settings") return { to: "settings" };
  const folder = /^\/folders\/([^/]+)$/.exec(pathname);
  if (folder) return { to: "folder", id: decodeURIComponent(folder[1]!) };
  return null;
}

/** Offline, or the sign-in ran out: a strip over the page, which stays as it is. */
function ConnectionStrip({ state }: { state: Snapshot }) {
  const again = signInAgainOf(state);
  const failed = (e: unknown) => notify(cleanError(e), "error");
  if (again?.kind === "token") {
    return (
      <SignInAgainBanner
        kind="token"
        error={again.error}
        onSubmitToken={(token) => void bridge["auth:signInWithToken"](again.appUrl, token).catch(failed)}
      />
    );
  }
  if (again) {
    return (
      <SignInAgainBanner
        kind={again.kind}
        signingIn={again.signingIn}
        error={again.error}
        onSignIn={() => void bridge["auth:signIn"](again.appUrl).catch(failed)}
        onCancel={() => void bridge["auth:cancelSignIn"]()}
      />
    );
  }
  if (connectionOf(state) === "offline") return <OfflineBanner />;
  return null;
}

/** Back online, or signed in again: refetch what failed meanwhile, the calendar included. */
function useRefetchOnReconnect(state: Snapshot) {
  const client = useQueryClient();
  const connection = connectionOf(state);
  const previous = useRef(connection);
  useEffect(() => {
    if (cameBackOnline(previous.current, connection)) {
      void retryUnsavedJottings();
      void client.invalidateQueries();
      // Coming up is main's calendar snapshot, not a query: ask main to refresh it now rather
      // than at its next poll, so an error from the outage clears with everything else.
      void bridge["calendar:refresh"]().catch(() => {});
    }
    previous.current = connection;
  }, [client, connection]);
}

function Layout({ state }: { state: AppSnapshot }) {
  const navigate = useNavigate();
  const router = useRouter();
  const client = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const folders = useQuery({ queryKey: keys.folders, queryFn: () => api.folders().then((r) => r.folders) });
  const me = useQuery({ queryKey: keys.me, queryFn: api.me });
  const levels = useLevels();
  const start = useStartRecording();
  const stop = useStopRecording();
  const [adding, setAdding] = useState<Space | null>(null);
  const [searching, setSearching] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const deferredRef = useRef(false);
  deferredRef.current = rememberDeferred(deferredRef.current, state);
  const pill = updatePillOf(state, deferredRef.current);
  const account = accountFrom(me.data, state.auth);
  const orgName = account?.orgName ?? "Team";

  useRefetchOnReconnect(state);
  const rec = state.recording;
  const onRecording = useCancelledStart();
  const followRecording = useFollowRecording();
  useEffect(() => {
    onRecording(rec);
    followRecording(rec);
  }, [rec, onRecording, followRecording]);
  const recordingId = rec.state !== "idle" ? rec.meetingId : undefined;
  const elapsedMs = useRecordingElapsed(rec);

  const onNavigate = (target: NavTarget) => {
    if (target.to === "home") void navigate({ to: "/" });
    else if (target.to === "shared") void navigate({ to: "/shared" });
    else if (target.to === "search") void navigate({ to: "/search", search: {} });
    else if (target.to === "templates") void navigate({ to: "/templates", search: {} });
    else if (target.to === "settings") void navigate({ to: "/settings" });
    else void navigate({ to: "/folders/$id", params: { id: target.id } });
  };

  // ⌘N starts a note now, as the menu bar's "Take notes now" does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        if (!recordingId && !newNoteBlockedReason(state)) void start({});
      }
      // ⌘K: the search palette, from anywhere (again closes it).
      if (event.metaKey && event.key.toLowerCase() === "k" && !event.shiftKey) {
        event.preventDefault();
        setSearching((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recordingId, start, navigate, state]);

  const deep = pathname.startsWith("/meetings/") || pathname.startsWith("/upcoming/");

  return (
    <>
      <AppFrame
        banner={<ConnectionStrip state={state} />}
        sidebar={{
          current: navFrom(pathname),
          onNavigate,
          folders: loadable(folders),
          orgName,
          account,
          onNewFolder: setAdding,
          onNewNote: () => void start({}),
          newNoteDisabledReason: newNoteBlockedReason(state),
          onSearch: () => setSearching(true),
          featureLabel: SCRIBE.label,
          update: pill
            ? {
                ...pill,
                restarting,
                onRestart: () => {
                  setRestarting(true);
                  void installUpdate(bridge)
                    .then((result) => {
                      if (result.deferred) notify("Every App restarts to update after this recording.");
                    })
                    .catch((e: unknown) => notify(cleanError(e), "error"))
                    .finally(() => setRestarting(false));
                },
              }
            : null,
          recording: recordingId
            ? {
                live: {
                  meetingId: recordingId,
                  title: rec.title ?? "Meeting",
                  startedAt: rec.startedAt ?? new Date().toISOString(),
                  mode: rec.mode ?? "realtime",
                  mic: rec.mic ?? "ok",
                  system: rec.system ?? "ok",
                },
                levels,
                elapsedMs,
              }
            : null,
          onOpenRecording: () => recordingId && void navigate({ to: "/meetings/$id", params: { id: recordingId } }),
          onStopRecording: () => void stop(),
        }}
        titleBar={
          deep && (
            <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => router.history.back()}>
              <ArrowLeft />
            </Button>
          )
        }
      >
        <Outlet />
      </AppFrame>
      {searching && (
        <Suspense fallback={null}>
          <Palette open={searching} onOpenChange={setSearching} />
        </Suspense>
      )}
      {adding !== null && (
        <Suspense fallback={null}>
          <NameDialog
            open={adding !== null}
            onOpenChange={(open) => !open && setAdding(null)}
            title={adding === "team" ? `New folder in ${orgName}` : "New folder"}
            description={adding === "team" ? "Everyone on the team sees this folder and the notes in it." : "Only you see this folder."}
            submitLabel="Create folder"
            placeholder="Customer calls"
            onSubmit={async (name) => {
              if (!adding) return;
              try {
                const { folder } = await api.createFolder({ name, space: adding });
                setAdding(null);
                await client.invalidateQueries({ queryKey: keys.folders });
                await navigate({ to: "/folders/$id", params: { id: folder.id } });
              } catch (error) {
                notify(`Couldn't create the folder. ${cleanError(error)}`, "error");
              }
            }}
          />
        </Suspense>
      )}
    </>
  );
}
