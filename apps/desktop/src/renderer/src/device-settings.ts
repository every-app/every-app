// The settings hook over main's settings:* channels (logic in settings-logic.ts).

import { useEffect, useSyncExternalStore } from "react";
import { SettingsController, type DeviceSettings } from "./settings-logic";
import { bridge, useAppState } from "./bridge";

let controller: SettingsController | undefined;
const shared = () => (controller ??= new SettingsController(bridge));

/** The settings, re-read from main whenever a page using them mounts. */
export function useDeviceSettings(): { settings: DeviceSettings | undefined; set: SettingsController["set"] } {
  const c = shared();
  const state = useAppState();
  useEffect(() => {
    void c.load().catch(() => {});
  }, [c]);
  useEffect(() => {
    if (state?.settings) c.receive(state.settings);
  }, [c, state?.settings]);
  const settings = useSyncExternalStore(c.subscribe, () => c.value);
  return { settings, set: (patch) => c.set(patch) };
}

