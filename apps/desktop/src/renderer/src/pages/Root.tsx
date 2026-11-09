// The window: sign-in and first-run permissions until they're done, then the app frame around
// the routed page.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AppSnapshot } from "@shared/ipc";
import type { NavTarget, Space } from "@every-app/desktop-ui";
import { exampleBackendUrl, SCRIBE } from "@shared/features";
import { AppFrame, OfflineBanner, OnboardingScreen, SignInAgainBanner, TitleBar } from "@every-app/desktop-ui";
import { useRecordingElapsed } from "../useRecordingElapsed";
import { Button } from "@every-app/desktop-ui/components/button";
import { clearDrafts, useCancelledStart, useFollowRecording, useStartRecording, useStopRecording } from "../actions";
import { api, cleanError, keys } from "../api";
import { grantPermission, newNoteBlockedReason, uiPermissions } from "../settings-logic";
import { cameBackOnline, connectionOf, gateOf, signInAgainOf, type Gate, type Snapshot } from "../connection";
import { retryUnsavedJottings } from "../jottings";
import { installUpdate, rememberDeferred, updatePillOf } from "../update";
import { useLevels } from "../live";
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
  if (gate === "welcome") return <SignIn state={state} />;
  if (!onboarded) {
    return (
      <FirstRun
        state={state}
        onDone={() => {
          localStorage.setItem(ONBOARDED_KEY, "1");
          setOnboarded(true);
        }}
      />
    );
  }
  return <Layout state={state} />;
}

function SignIn({ state }: { state: AppSnapshot }) {
  // Signed out: before-call drafts belong to the account that wrote them.
  useEffect(() => clearDrafts(), []);
  const [appUrl, setAppUrl] = useState(state.auth.appUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<void>) => {
    setError(null);
    work().catch((e: unknown) => setError(cleanError(e)));
  };
  return (
    <OnboardingScreen
      step="sign-in"
      appUrl={appUrl}
      appUrlPlaceholder={exampleBackendUrl(SCRIBE, "your-team.everyapp.dev")}
      onAppUrlChange={setAppUrl}
      signingIn={state.auth.status === "signingIn"}
      signInError={error ?? state.auth.error ?? null}
      onSignIn={() => run(() => bridge["auth:signIn"](appUrl.trim()))}
      onCancelSignIn={() => void bridge["auth:cancelSignIn"]()}
      onSubmitToken={(token) => run(() => bridge["auth:signInWithToken"](appUrl.trim(), token))}
    />
  );
}

function FirstRun({ state, onDone }: { state: AppSnapshot; onDone: () => void }) {
  const [step, setStep] = useState<"permissions" | "done">("permissions");
  const permissions = uiPermissions(state.permissions);
  return (
    <OnboardingScreen
      step={step}
      accountName={accountFrom(undefined, state.auth)?.name}
      permissions={permissions}
      onGrant={(kind) =>
        void grantPermission(bridge, kind, permissions[kind]).then(
          ({ hint }) => hint && notify(hint),
          (e: unknown) => notify(cleanError(e), "error"),
        )
      }
      onContinue={() => setStep("done")}
      onFinish={onDone}
    />
  );
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
