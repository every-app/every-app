// Main's side of the typed bridge (src/shared/ipc.ts). Every handler checks that the call came
// from our own renderer and validates its arguments; the renderer gets nothing else.

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { InvokeChannel, InvokeMap } from "@shared/ipc";
import { validArgs } from "./ipcValidation";
import { isAppUrl, type AppOrigin } from "./navigation";

type Handler<C extends InvokeChannel> = (...args: InvokeMap[C][0]) => Promise<InvokeMap[C][1]> | InvokeMap[C][1];
export type Handlers = { [C in InvokeChannel]: Handler<C> };

/** The call came from Every App's own page (the bundled index.html, or the dev server unpackaged). */
export function isOurRenderer(event: IpcMainInvokeEvent, origin: AppOrigin): boolean {
  return isAppUrl(event.senderFrame?.url ?? "", origin);
}

export function registerIpc(handlers: Handlers, origin: AppOrigin): void {
  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isOurRenderer(event, origin)) throw new Error("Refused: not Every App's window.");
      if (!validArgs(channel, args)) throw new Error(`Refused: bad arguments for ${channel}.`);
      return (handlers[channel] as (...a: unknown[]) => unknown)(...args);
    });
  }
}
