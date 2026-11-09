import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { PermissionKind } from "@shared/ipc";
import { SettingsScreen, useThemePreference, type SelfTestState, type ThemePreference } from "@every-app/desktop-ui";
import { api, cleanError, keys } from "../api";
import { useDeviceSettings } from "../device-settings";
import { accountFrom, calendarConnectionFrom, loadable } from "../map";
import { notify } from "../notice";
import { grantPermission, loginItemHint, selfTestBlockedReason, uiPermissions } from "../settings-logic";
import { resetSelfTestProgress, useLevels, useSelfTestProgress } from "../live";
import { bridge, useAppState } from "../bridge";

const granted: Record<PermissionKind, string> = {
  mic: "Microphone is on.",
  systemAudio: "System audio is on.",
  notifications: "Notifications are on.",
};

export function SettingsPage() {
  const state = useAppState();
  const me = useQuery({ queryKey: keys.me, queryFn: api.me });
  const { themePreference, setThemePreference } = useThemePreference();
  const { settings, set } = useDeviceSettings();
  const [hints, setHints] = useState<Partial<Record<PermissionKind, string>>>({});
  const [test, setTest] = useState<SelfTestState>({ kind: "idle" });
  const levels = useLevels(); // the helper's levels, live while the check runs
  const progress = useSelfTestProgress();
  // The audio check runs until Stop, or until the person leaves Settings or hides the window.
  const checking = useRef(false);
  checking.current = test.kind === "checking";
  useEffect(() => {
    const stop = () => {
      if (checking.current) void bridge["selftest:stop"]().catch(() => {});
    };
    const onVisibility = () => document.visibilityState === "hidden" && stop();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, []);
  const permissions = uiPermissions(state?.permissions);

  const change = (patch: Parameters<typeof set>[0]) =>
    void set(patch).catch((e: unknown) => notify(`Couldn't save that. ${cleanError(e)}`, "error"));

  const account = accountFrom(me.data, state?.auth);

  return (
    <SettingsScreen
      account={
        account
          ? { status: "ready", data: account }
          : me.isPending
            ? { status: "loading" }
            : { status: "error", message: "Couldn't load your account." }
      }
      permissions={state ? { status: "ready", data: permissions } : { status: "loading" }}
      permissionHints={hints}
      calendar={loadable(me, calendarConnectionFrom)}
      launchAtLogin={settings?.launchAtLogin ?? false}
      detectCalls={settings?.callDetection ?? true}
      recordShortcut={settings?.recordShortcut}
      recordShortcutStatus={state?.recordShortcut}
      onRecordShortcutChange={(recordShortcut) => change({ recordShortcut })}
      floatingRecorder={settings?.floatingRecorder}
      onFloatingRecorderChange={(floatingRecorder) => change({ floatingRecorder })}
      theme={themePreference}
      version={state?.version}
      launchAtLoginHint={loginItemHint(state?.loginItem?.status, settings?.launchAtLogin ?? false)}
      onSignOut={() => void bridge["auth:signOut"]()}
      onGrant={(kind) =>
        void grantPermission(bridge, kind, permissions[kind]).then(
          ({ status, hint }) => {
            setHints((h) => ({ ...h, [kind]: hint }));
            if (status === "granted") notify(granted[kind]);
          },
          (e: unknown) => notify(cleanError(e), "error"),
        )
      }
      onOpenSystemSettings={(kind) => void bridge["permissions:openSettings"](kind).catch((e: unknown) => notify(cleanError(e), "error"))}
      selfTest={{
        state: test.kind === "checking" ? { kind: "checking", progress, levels } : test,
        disabledReason: selfTestBlockedReason(state, test.kind === "checking"),
        onStart: () => {
          resetSelfTestProgress();
          setTest({ kind: "checking", levels: { mic: 0, system: 0 } });
          void bridge["selftest:run"]().then(
            (report) => setTest({ kind: "done", report }),
            (e: unknown) => setTest({ kind: "error", message: cleanError(e) }),
          );
        },
        onStop: () => void bridge["selftest:stop"]().catch((e: unknown) => notify(cleanError(e), "error")),
        onOpenSettings: (pane) =>
          void bridge["permissions:openSettings"](pane).catch((e: unknown) => notify(cleanError(e), "error")),
      }}
      onConnectCalendar={() => void bridge["calendar:connect"]()}
      onLaunchAtLoginChange={(launchAtLogin) => change({ launchAtLogin })}
      onDetectCallsChange={(callDetection) => change({ callDetection })}
      onThemeChange={(theme: ThemePreference) => {
        setThemePreference(theme);
        change({ theme });
      }}
    />
  );
}
