// Every App's main process: sign-in and tokens, the tray, the window, calendar prompts, the updater,
// and the helper supervisor. The renderer reaches it only through the typed preload bridge.

import { app, BrowserWindow, clipboard, dialog, globalShortcut, net, Notification, powerMonitor, session, shell, safeStorage } from "electron";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { AppSnapshot, LoginItemSnapshot, PermissionKind, StartRecordingRequest } from "@shared/ipc";
import type { CalendarEvent } from "@shared/api";
import { AuthService } from "./auth/service";
import { SecretStore } from "./auth/store";
import { errorMessage } from "./auth/oauth";
import { CalendarService, formatTime, STILL_RECORDING_PROMPT } from "./calendar/service";
import { isOpenLink, parseDeepLink, resolveDeepLink } from "./calendar/deepLink";
import { names, pinStorage, restoreDisplayName, urlSchemes } from "./identity";
import { PromptLedger } from "./calendar/ledger";
import { devSignIn, helperPath, isDevFlavor, keychainDisabled } from "./config";
import { HelperSupervisor } from "./helper/supervisor";
import { registerIpc } from "./ipc";
import { isCopyableUrl, normalizedLink } from "./clipboard";
import { SETUP_COMMANDS } from "@shared/setup";
import { log, logPath, logTail } from "./log";
import { Connectivity } from "./connectivity";
import { PendingUploads } from "./pending";
import { buildDiagnostics } from "./diagnostics";
import { RecordingController } from "./recording";
import { scaled, STILL_RECORDING, StillRecordingGuard } from "./stillRecording";
import { TrayController, trayStateFor } from "./tray";
import { createUpdater } from "./updater";
import type { UpdateController } from "./updates";
import { RecordShortcut } from "./shortcut";
import { MainWindow } from "./window";
import { LiveTranscriptBuffer } from "./liveTranscript";
import { shouldShowPill } from "./pill";
import { RecorderPillWindow } from "./pillWindow";
import { AppMenu } from "./menu";
import { isSignInEndpoint, typedAppUrl } from "./auth/url";
import { guardNavigation, type AppOrigin } from "./navigation";
import { helperIdentity, PermissionProbe } from "./permissions";
import { SettingsStore } from "./settings";
import { freshProfileDir, removeFreshProfile } from "./devProfile";
import { SelfTestController } from "./selftest";
import { applyLoginItem, applyTheme, loginItemStatus, requestNotificationPermission, settingsPaneUrl } from "./system";

// Local data, logs and the Keychain item live under fixed names (identity.json), never the display
// name; a dev build ("Every App Dev", or `electron-vite dev`) has its own, apart from the installed
// Every App. An explicit --user-data-dir (a test driver's throwaway profile) wins, so it never
// shares the installed app's userData or single-instance lock.
pinStorage();

/** EVERYAPP_DESKTOP_DEV_FRESH=1 in a dev build: a brand-new profile for this run, deleted on quit
 * (devProfile.ts). Onboarding shows again; the normal Every App Dev profile isn't touched. */
const freshProfile = freshProfileDir(process.env, isDevFlavor());
if (freshProfile) {
  app.setPath("userData", freshProfile);
  app.on("quit", () => removeFreshProfile(freshProfile));
}

/** Every App's own page: the bundled renderer, or the electron-vite dev server in an unpackaged run.
 * Navigation guards and IPC sender checks both use it. */
const origin: AppOrigin = {
  rendererFile: join(__dirname, "../renderer/index.html"),
  otherPages: [join(__dirname, "../renderer/pill.html")],
  devUrl: !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined,
};

const pendingUrls: string[] = [];
let handleUrl: ((url: string) => void) | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (handleUrl) handleUrl(url);
    else pendingUrls.push(url);
  });
  // Only Every App's own page loads in a window; https links go to the browser; no webviews.
  app.on("web-contents-created", (_e, contents) => {
    guardNavigation(contents, origin, (url) => void shell.openExternal(url), log);
  });
  void app.whenReady().then(main);
}

async function main(): Promise<void> {
  restoreDisplayName();
  log(`Every App ${app.getVersion()} (${app.getName()}) starting; packaged ${app.isPackaged}`);
  if (freshProfile) log(`dev: a fresh profile for this run (EVERYAPP_DESKTOP_DEV_FRESH), deleted on quit: ${freshProfile}`);
  // The renderer needs no device or other permission; the helper does the capturing.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"), log);
  settings.load();
  applyTheme(settings.value.theme);
  const probe = new PermissionProbe(join(app.getPath("userData"), "permissions.json"), log);
  probe.load();
  // The login item can be removed in System Settings: what macOS says wins over the saved setting.
  let loginItem: LoginItemSnapshot = loginItemStatus();
  if (loginItem.status === "enabled" && !settings.value.launchAtLogin) settings.set({ launchAtLogin: true });
  if (loginItem.status === "disabled" && settings.value.launchAtLogin) settings.set({ launchAtLogin: false });

  const noKeychain = keychainDisabled();
  if (noKeychain) log("dev: the Keychain is off; sign-ins last until quit (EVERYAPP_DESKTOP_DEV_KEYCHAIN=1 to keep them)");
  const store = new SecretStore(
    join(app.getPath("userData"), "signin.bin"),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (data) => safeStorage.decryptString(data),
    },
    noKeychain,
  );
  let connectivity: Connectivity | undefined;
  const auth = new AuthService({
    store,
    // Only ever a Gateway's authorize URL; discovery already refuses other schemes (auth/url.ts).
    openBrowser: async (url) => {
      if (!isSignInEndpoint(url)) throw new Error("Refused to open a sign-in page that isn't https.");
      await shell.openExternal(url);
    },
    log,
    onApiOutcome: (error) => connectivity?.report(error),
  });
  connectivity = new Connectivity({
    probe: async () => {
      const api = auth.api;
      if (!api) return undefined;
      try {
        await api.me();
        return undefined;
      } catch (error) {
        auth.handleError(error);
        return error;
      }
    },
    signedIn: () => auth.state.status === "signedIn",
    log,
  });
  const online = connectivity;
  const pending = new PendingUploads(join(app.getPath("userData"), "pending"), log);

  const helper = new HelperSupervisor({
    path: helperPath(),
    freshToken: () => auth.freshAccessToken(),
    log,
  });
  const recording = new RecordingController(auth, helper, log);
  recording.saveFailuresExpected = () => online.state !== "online";
  /** Sends what earlier recordings couldn't save, when the app is reachable and signed in. */
  const replayPending = async () => {
    const api = auth.api;
    if (!api || online.state !== "online") return;
    try {
      await pending.replay(api);
    } catch (error) {
      log(`pending replay failed: ${errorMessage(error)}`);
    }
  };
  const window = new MainWindow(join(__dirname, "../preload/index.js"));
  /** The floating recorder (pill.ts): its live transcript, in memory only, bounded. */
  const liveTranscript = new LiveTranscriptBuffer();
  const pill = new RecorderPillWindow({
    preloadPath: join(__dirname, "../preload/index.js"),
    devUrl: origin.devUrl,
    recording: () => recording.state,
    transcript: liveTranscript,
    log,
  });
  const syncPill = () => {
    const r = recording.state;
    // Each recording starts clean; nothing is kept once it ends.
    if (r.state === "idle") liveTranscript.reset();
    else if (r.meetingId && r.meetingId !== liveTranscript.value.meetingId) liveTranscript.reset(r.meetingId);
    pill.setVisible(shouldShowPill(r.state, settings.value.floatingRecorder));
    pill.push();
  };
  const selfTest = new SelfTestController(helper, () => recording.isActive, log);
  recording.startBlocked = () =>
    selfTest.state.running ? "Every App is checking your microphone and Mac audio. Stop the check in Settings, then start recording." : undefined;

  let updates: UpdateController | undefined;
  /** Restart into a downloaded update. The window hides instead of closing, so mark the quit
   * first, or the updater would wait for it forever; during a recording the controller defers. */
  const installUpdate = (): { deferred: boolean } => {
    if (!updates) return { deferred: false };
    if (!recording.isActive && updates.state.state === "ready") window.quitting = true;
    const result = updates.install();
    if (result.deferred) calendar.notify("Update after this recording", "Every App will offer to restart when you stop recording.");
    return result;
  };

  const notifyError = (title: string, error: unknown) => calendar.notify(title, errorMessage(error));

  const startRecording = async (req: StartRecordingRequest & { event?: CalendarEvent }) => {
    const event = req.event ?? (req.calendarEventId ? calendar.state.events.find((e) => e.id === req.calendarEventId) : undefined);
    if (req.join && event?.conferenceUrl?.startsWith("https://")) void shell.openExternal(event.conferenceUrl);
    const options = event
      ? RecordingController.titleFor(event)
      : { title: req.title?.trim() || RecordingController.nowTitle(), calendarEventId: req.calendarEventId };
    if (!recording.isActive) stillRecording.setCalendarEnd(event?.end ? Date.parse(event.end) : undefined);
    await recording.start(options);
    if (options.calendarEventId) calendar.clear(options.calendarEventId);
  };

  const calendar = new CalendarService(
    auth,
    {
      takeNotes: (event, join) => void startRecording({ event, join }).catch((e) => notifyError("Scribe couldn't start", e)),
      recordCall: (appName) =>
        void startRecording({ title: `${appName} call` }).catch((e) => notifyError("Scribe couldn't start", e)),
      isRecording: () => recording.isActive,
      recordingEventId: () => (recording.isActive ? recording.state.calendarEventId : undefined),
      reminderLeadMs: () => settings.value.reminderLeadMinutes * 60_000,
      notificationResult: (shown) => probe.notificationResult(shown),
    },
    log,
    new PromptLedger(join(app.getPath("userData"), "prompts.json")).load(),
  );

  /** "Still recording?": asks when a recording looks forgotten, and stops it if nobody answers. */
  let stillDialog: AbortController | undefined;
  const stillRecording = new StillRecordingGuard({
    enabled: () => settings.value.autoStop,
    now: () => Date.now(),
    ask: (prompt, answer) =>
      calendar.prompt(STILL_RECORDING_PROMPT, {
        ...prompt,
        onAction: answer,
        // Notifications are off for Every App: ask in a dialog, so the question is never unseen.
        onFailed: () => {
          stillDialog?.abort();
          const asking = (stillDialog = new AbortController());
          void dialog
            .showMessageBox({ type: "question", message: prompt.title, detail: prompt.body, buttons: [...prompt.actions], defaultId: 0, cancelId: 0, signal: asking.signal })
            .then((r) => {
              if (!asking.signal.aborted) answer(r.response);
            })
            .catch(() => {});
        },
      }),
    dismiss: () => {
      calendar.dismiss(STILL_RECORDING_PROMPT);
      stillDialog?.abort();
      stillDialog = undefined;
    },
    notify: (title, body) => calendar.notify(title, body),
    stop: () => void recording.stop().catch((e) => notifyError("Scribe couldn't stop", e)),
    time: (ms) => formatTime(new Date(ms).toISOString()),
    log,
    // Dev builds only: EVERYAPP_DESKTOP_STILL_RECORDING_SPEEDUP=10 makes every wait ten times shorter.
    config: isDevFlavor() ? scaled(STILL_RECORDING, Number(process.env.EVERYAPP_DESKTOP_STILL_RECORDING_SPEEDUP)) : STILL_RECORDING,
  });
  setInterval(() => stillRecording.tick(), 5_000).unref();

  const tray = new TrayController({
    open: () => window.show(),
    start: () => void startRecording({}).catch((e) => notifyError("Scribe couldn't start", e)),
    stop: () => void recording.stop().catch((e) => notifyError("Scribe couldn't stop", e)),
    quit: () => app.quit(),
    installUpdate: () => void installUpdate(),
  });

  /** ⌃⌥⌘R from anywhere (the setting is off by default): start a recording, or stop the one running. */
  const shortcut = new RecordShortcut(
    {
      register: (accelerator, fn) => globalShortcut.register(accelerator, fn),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    () => {
      if (recording.isActive) void recording.stop().catch((e) => notifyError("Scribe couldn't stop", e));
      else void startRecording({}).catch((e) => notifyError("Scribe couldn't start", e));
    },
    log,
  );
  app.on("will-quit", () => shortcut.set(false));

  /** About Every App: the app and recorder versions (from the helper's hello). */
  const setAbout = () =>
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
      version: helper.state.version ? `recorder ${helper.state.version}` : "recorder not running",
      copyright: "Every App",
      credits: "Help → Copy Diagnostics copies what support needs.",
    });
  setAbout();

  const menu = new AppMenu({
    open: () => window.show(),
    settings: () => window.showAndSend("navigate", { to: "settings" }),
    start: () => void startRecording({}).catch((e) => notifyError("Scribe couldn't start", e)),
    stop: () => void recording.stop().catch((e) => notifyError("Scribe couldn't stop", e)),
    checkForUpdates: () => {
      if (!updates) {
        // No feed in this build (EVERYAPP_DESKTOP_UPDATE_URL wasn't set when it was built).
        void dialog.showMessageBox({
          type: "info",
          message: "Updates aren't set up in this build",
          detail: `This copy of ${app.getName()} (${app.getVersion()}) was built without an update feed, so it can't check for updates. Release builds check by themselves.`,
          buttons: ["OK"],
        });
        log("updates: Check for Updates… in a build without a feed");
        return;
      }
      void updates.check(true).then(() => {
        const u = updates?.state;
        if (u?.state === "upToDate") calendar.notify("Every App is up to date", `You have ${app.getVersion()}.`);
        else if (u?.state === "error") calendar.notify("Couldn't check for updates", u.error ?? "");
      });
    },
    installUpdate: () => void installUpdate(),
    // Dev builds: show first run again, without touching anything else in the profile.
    resetOnboarding: isDevFlavor()
      ? () => {
          window.show();
          const wc = window.webContents;
          if (!wc || wc.isDestroyed()) return;
          void wc
            .executeJavaScript('localStorage.removeItem("everyapp.onboarded")')
            .then(() => wc.reload())
            .then(() => log("dev: onboarding reset"))
            .catch((e: unknown) => log(`dev: couldn't reset onboarding: ${errorMessage(e)}`));
        }
      : undefined,
    showLogs: () => {
      const path = logPath();
      if (path) shell.showItemInFolder(path);
    },
    copyDiagnostics: () => {
      clipboard.writeText(
        buildDiagnostics({
          snapshot: snapshot(),
          versions: {
            app: app.getVersion(),
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            os: `${process.platform} ${process.getSystemVersion()}`,
            arch: process.arch,
          },
          recordingCrashes: recording.crashCount,
          pendingUploads: pending.count,
          logTail: logTail(50),
        }),
      );
      log("diagnostics copied to the clipboard");
    },
  });

  const snapshot = (): AppSnapshot => {
    const s = {
      version: app.getVersion(),
      auth: auth.state,
      helper: helper.state,
      recording: recording.state,
      calendar: calendar.state,
      updater: updates?.state ?? { enabled: false, state: "idle" as const },
      recordShortcut: shortcut.status,
      selfTest: selfTest.state,
      settings: settings.value,
      connection: online.state,
      permissions: probe.snapshot(helper.state.permissions),
      loginItem,
    };
    return { ...s, tray: trayStateFor(s) };
  };
  let queued = false;
  const broadcast = () => {
    if (queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      const s = snapshot();
      tray.update(s);
      menu.update(s);
      window.send("state", s);
    });
  };

  let wasSignedIn = false;
  let restoredPrompts = false;
  /** Call detection runs while signed in, if the setting is on. */
  const syncDetection = () => void helper.setDetection(wasSignedIn && settings.value.callDetection).catch(() => {});
  auth.on("change", (a) => {
    const signedIn = a.status === "signedIn";
    online.setSignInNeeded(!!a.expired || !!a.needsEveryAppSignIn);
    if (signedIn && !wasSignedIn) {
      void auth.loadMe();
      // Signed in again during a recording (after an expiry): unblock the helper's posts now.
      if (recording.isActive) {
        void auth
          .accessToken()
          .then(async (accessToken) => {
            if (accessToken) await helper.request("token.update", { accessToken });
          })
          .catch((e) => log(`token.update after sign-in failed: ${errorMessage(e)}`));
      }
      void replayPending();
      calendar.start();
      if (!restoredPrompts) {
        restoredPrompts = true;
        void calendar.restoreDelivered();
      }
      wasSignedIn = true;
      syncDetection();
    } else if (!signedIn && wasSignedIn) {
      calendar.stop();
      wasSignedIn = false;
      syncDetection();
      if (a.expired) {
        // Not the person's choice: keep recording. The helper queues segments until a new sign-in
        // sends token.update; the window asks to sign in again in place.
        log("sign-in expired; waiting for a new sign-in" + (recording.isActive ? " (the recording continues)" : ""));
      } else {
        online.reset();
        if (recording.isActive) void recording.stop().catch(() => {});
      }
    }
    wasSignedIn = signedIn;
    broadcast();
  });
  let loggedPermissions = "";
  let helperHello = "";
  helper.on("status", (h) => {
    // A (re)started helper said hello: key "system audio verified" to this binary, and never let
    // the fake helper's made-up levels count.
    const hello = h.status === "ready" ? `${h.version}|${h.macos}|${h.restarts}` : "";
    if (hello && hello !== helperHello) {
      const path = helperPath();
      let stat: { size?: number; mtimeMs?: number } = {};
      try {
        const st = statSync(path);
        stat = { size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        // Gone: no identity, so nothing counts.
      }
      probe.setHelper(helperIdentity({ path, ...stat, version: h.version, macos: h.macos }));
      setAbout();
    }
    helperHello = hello || helperHello;
    const key = JSON.stringify(h.permissions ?? null);
    if (h.permissions && key !== loggedPermissions) {
      loggedPermissions = key;
      const p = probe.snapshot(h.permissions);
      log(`permissions: mic ${p.mic}, systemAudio ${p.systemAudio} (helper: ${h.permissions.systemAudio}), notifications ${p.notifications}`);
    }
    broadcast();
  });
  probe.on("change", broadcast);
  selfTest.on("change", broadcast);
  settings.on("change", (value, changed) => {
    log(`settings changed: ${Object.keys(changed).join(", ")}`);
    if (changed.theme !== undefined) applyTheme(value.theme);
    if (changed.callDetection !== undefined) {
      syncDetection();
      if (!value.callDetection) stillRecording.callsUnknown();
    }
    if (changed.autoStop !== undefined) stillRecording.enabledChanged(recording.state);
    if (changed.reminderLeadMinutes !== undefined) calendar.replan();
    if (changed.launchAtLogin !== undefined) loginItem = applyLoginItem(value.launchAtLogin, log);
    if (changed.recordShortcut !== undefined) shortcut.set(value.recordShortcut);
    if (changed.floatingRecorder !== undefined) syncPill();
    broadcast();
  });
  let wasRecording = false;
  recording.on("change", (r) => {
    // A restart asked for during the recording waits for it to end.
    const active = r.state !== "idle";
    if (wasRecording && !active) updates?.recordingStopped();
    wasRecording = active;
    stillRecording.recordingChanged(r);
    syncPill();
    broadcast();
  });
  recording.on("crashed", () => {
    calendar.notify("Recording stopped unexpectedly", "Notes are being written from what was captured. Every App is restarting its recorder.");
  });
  recording.on("unsaved", ({ meetingId, appUrl, segments, needsFinish }) => {
    try {
      pending.add(meetingId, appUrl, segments, needsFinish);
    } catch (error) {
      log(`couldn't keep unsaved segments for ${meetingId}: ${errorMessage(error)}`);
    }
    void replayPending();
  });
  online.on("change", (c) => {
    log(`connection: ${c}`);
    if (c === "online") void replayPending();
    broadcast();
  });
  powerMonitor.on("resume", () => online.resumed());
  // Back in the window from System Settings or the browser (connecting Google Calendar): read
  // again what may have changed out there.
  app.on("browser-window-focus", (_event, focused) => {
    if (focused.webContents !== window.webContents) return;
    if (helper.state.status === "ready") void helper.refreshPermissions().catch((e) => log(`permissions.status failed: ${errorMessage(e)}`));
    if (!calendar.state.connected) void calendar.refresh();
  });
  setInterval(() => online.setOsOnline(net.isOnline()), 15_000).unref();
  calendar.on("change", (c) => {
    // The meeting being recorded was moved or extended: its end time follows.
    const recorded = recording.isActive ? c.events.find((e) => e.id === recording.state.calendarEventId) : undefined;
    if (recorded?.end) stillRecording.setCalendarEnd(Date.parse(recorded.end));
    broadcast();
  });
  helper.on("exit", () => stillRecording.callsUnknown());
  helper.on("event", (event) => {
    stillRecording.helperEvent(event);
    probe.observe(event);
    window.send("helper", event);
    liveTranscript.observe(event);
    pill.helperEvent(event);
    if (event.event === "call.started") calendar.callStarted(event.bundleId, event.appName);
    if (event.event === "call.ended") calendar.callEnded(event.bundleId);
  });

  const requireApi = () => {
    const api = auth.api;
    if (!api) throw new Error("Sign in to Scribe first.");
    return api;
  };
  const withAuth = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (error) {
      auth.handleError(error);
      throw error;
    }
  };

  registerIpc({
    "state:get": () => snapshot(),
    "auth:locate": (text) => auth.locate(text),
    "auth:signIn": (appUrl) => auth.signIn(appUrl),
    "auth:cancelSignIn": () => auth.cancelSignIn(),
    "auth:signInWithToken": (appUrl, token) => auth.signInWithToken(appUrl, token),
    "auth:signOut": () => auth.signOut(),
    "recording:start": (req) => startRecording(req),
    "recording:stop": () => recording.stop(),
    "helper:requestPermission": async (kind) => {
      await helper.requestPermission(kind);
    },
    "permissions:get": async () => {
      if (helper.state.status === "ready") await helper.refreshPermissions().catch((e) => log(`permissions.status failed: ${errorMessage(e)}`));
      return probe.snapshot(helper.state.permissions);
    },
    "permissions:request": async (kind: PermissionKind) => {
      if (kind === "notifications") {
        const shown = await requestNotificationPermission();
        if (shown !== undefined) probe.notificationResult(shown);
      } else {
        await helper.requestPermission(kind);
      }
      return probe.snapshot(helper.state.permissions);
    },
    "permissions:openSettings": async (pane) => {
      await shell.openExternal(settingsPaneUrl(pane, names.appId));
    },
    "settings:get": () => settings.value,
    "settings:set": (patch) => {
      settings.set(patch);
      // The login item may need approval or may fail: report what macOS says.
      if (patch.launchAtLogin !== undefined && loginItem.status === "disabled" && settings.value.launchAtLogin) {
        settings.set({ launchAtLogin: false });
      }
      return settings.value;
    },
    "calendar:refresh": () => calendar.refresh(),
    "calendar:connect": async () => {
      const url = calendar.state.connectUrl ?? auth.user?.connectUrl;
      if (url && (url.startsWith("https://") || typedAppUrl(url))) await shell.openExternal(url);
    },
    "api:me": () => withAuth(() => requireApi().me()),
    "api:meetings": () => withAuth(() => requireApi().meetings()),
    "api:meeting": (id) => withAuth(() => requireApi().meeting(id)),
    "api:updateMeeting": (id, patch) => withAuth(() => requireApi().updateMeeting(id, patch)),
    "api:call": (method, path, opts) => withAuth(() => requireApi().call(method, path, opts)),
    "update:install": () => installUpdate(),
    "pill:get": () => pill.view(),
    "pill:openMeeting": () => {
      const meetingId = recording.state.meetingId;
      if (meetingId) window.showAndSend("navigate", { to: "meeting", meetingId });
      else window.show();
    },
    "selftest:run": () => selfTest.run(),
    "selftest:stop": () => selfTest.stop(),
    "clipboard:writeText": (text) => {
      if (!isCopyableUrl(text, auth.api?.appUrl)) throw new Error("Refused: only https links or this Scribe's own links can be copied.");
      clipboard.writeText(normalizedLink(text));
    },
    "clipboard:copySetup": (id) => {
      clipboard.writeText(SETUP_COMMANDS[id]);
    },
    "app:openInBrowser": async (meetingId) => {
      const base = auth.api?.appUrl;
      if (!base) return;
      await shell.openExternal(meetingId ? `${base}/meetings/${encodeURIComponent(meetingId)}` : base);
    },
  }, origin);

  // everyapp://scribe/record links (from the Scribe web app). Any page can open one: start at once only for an
  // event in our own upcoming list, otherwise ask.
  let handlingUrl = false;
  handleUrl = (raw) => {
    if (isOpenLink(raw, urlSchemes)) return window.show();
    const request = parseDeepLink(raw, urlSchemes);
    if (!request) return log(`ignored a URL with scheme ${raw.split(":")[0]}`);
    if (auth.state.status !== "signedIn") return window.show();
    if (recording.isActive) {
      return calendar.notify("Scribe is already taking notes", `For “${recording.state.title ?? "a meeting"}”. Stop it from the menu bar to start another.`);
    }
    if (handlingUrl) return;
    handlingUrl = true;
    void (async () => {
      try {
        if (!calendar.state.lastRefresh) await calendar.refresh();
        const action = resolveDeepLink(request, calendar.state.events, RecordingController.nowTitle());
        if (action.kind === "start") return await startRecording({ event: action.event, join: action.join });
        window.show();
        const parent = BrowserWindow.getFocusedWindow();
        const options = {
          type: "question" as const,
          message: `Start taking notes for “${action.title}”?`,
          detail: "Scribe will transcribe your microphone and your Mac's sound.",
          buttons: ["Take Notes", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        };
        const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        if (response !== 0 || recording.isActive) return;
        await recording.start({ title: action.title, startsAt: action.start, calendarEventId: action.eventId });
      } catch (error) {
        notifyError("Scribe couldn't start", error);
      } finally {
        handlingUrl = false;
      }
    })();
  };

  // Quit: stop a recording first (the helper posts its last segments), then the helper.
  let quitReady = false;
  app.on("before-quit", (e) => {
    window.quitting = true;
    if (quitReady) return;
    e.preventDefault();
    void (async () => {
      try {
        if (recording.isActive) await recording.stop();
      } catch (error) {
        log(`stop on quit failed: ${errorMessage(error)}`);
      }
      await helper.stop();
      tray.destroy();
      quitReady = true;
      app.quit();
    })();
  });
  app.on("second-instance", (_e, argv) => {
    for (const arg of argv) if (urlSchemes.some((s) => arg.startsWith(`${s}:`))) handleUrl?.(arg);
    window.show();
  });
  app.on("activate", () => window.show());
  // Closing the last window keeps Every App in the tray.
  app.on("window-all-closed", () => {});

  tray.create();
  auth.restore();
  if (auth.state.status !== "signedIn") {
    const dev = devSignIn();
    if (dev) {
      const appUrl = typedAppUrl(dev.appUrl);
      if (appUrl) {
        log(`dev sign-in with a token for ${new URL(appUrl).host}`);
        auth.useEphemeral({ kind: "token", appUrl, token: dev.token });
      }
    }
  }
  helper.start();
  window.show();
  broadcast();
  shortcut.set(settings.value.recordShortcut);
  updates = await createUpdater({
    appUrl: () => auth.api?.appUrl,
    accessToken: () => auth.accessToken(),
    freshAccessToken: () => auth.freshAccessToken(),
    canCheck: () => auth.state.status === "signedIn" && online.state === "online",
    isRecording: () => recording.isActive,
    log,
  });
  if (updates) {
    updates.on("change", broadcast);
    updates.on("ready", ({ version }) => window.send("update", { state: "ready", version }));
    updates.on("offer", ({ version }) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: "Restart to update Every App", body: `Every App ${version} is ready. Click to restart now.` });
      n.on("click", () => void installUpdate());
      n.show();
    });
    updates.start();
    // A check that was skipped (signed out or offline at launch) runs once that changes.
    online.on("change", (c) => c === "online" && void updates?.check(false));
    auth.on("change", (a) => a.status === "signedIn" && void updates?.check(false));
  }
  broadcast();
  for (const url of pendingUrls.splice(0)) handleUrl(url);
}
