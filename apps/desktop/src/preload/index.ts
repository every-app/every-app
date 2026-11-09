// The only door from the renderer to main: `window.everyapp`, one function per invoke channel plus
// `on(channel, listener)` for pushes. Nothing from ipcRenderer itself is exposed.

import { contextBridge, ipcRenderer } from "electron";
import { EVENT_CHANNELS, INVOKE_CHANNELS, type EventChannel, type EventMap, type DesktopBridge } from "@shared/ipc";

const bridge: Record<string, unknown> = {};
for (const channel of INVOKE_CHANNELS) {
  bridge[channel] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}
bridge.on = <C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void) => {
  if (!EVENT_CHANNELS.includes(channel)) throw new Error(`Unknown channel ${channel}`);
  const wrapped = (_e: Electron.IpcRendererEvent, payload: EventMap[C]) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};

contextBridge.exposeInMainWorld("everyapp", bridge as DesktopBridge);
