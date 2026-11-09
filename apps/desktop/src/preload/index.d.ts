import type { DesktopBridge } from "../shared/ipc";

declare global {
  interface Window {
    everyapp: DesktopBridge;
  }
}

export {};
