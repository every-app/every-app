// Makes the UpdateController (updates.ts) for this build: electron-updater's autoUpdater when the
// packaged release has a feed (app-update.yml, written when EVERYAPP_DESKTOP_UPDATE_URL was set at build),
// the fake updater for an e2e run (EVERYAPP_DESKTOP_E2E_FAKE_UPDATE=<version>, dev builds only), else none.

import { readFileSync } from "node:fs";
import { isDevFlavor, updateConfigPath } from "./config";
import { feedUrlFrom } from "./updateAuth";
import { electronUpdater } from "./updaterModule";
import { fakeUpdater, UpdateController, type UpdateControllerOptions, type Updater } from "./updates";

export type UpdaterContext = Omit<UpdateControllerOptions, "updater" | "feedUrl">;

export async function createUpdater(context: UpdaterContext): Promise<UpdateController | undefined> {
  const fakeVersion = process.env.EVERYAPP_DESKTOP_E2E_FAKE_UPDATE;
  if (fakeVersion && isDevFlavor()) {
    context.log?.(`updates: fake updater (EVERYAPP_DESKTOP_E2E_FAKE_UPDATE=${fakeVersion})`);
    return new UpdateController({ ...context, updater: fakeUpdater(fakeVersion, context.log) });
  }
  const config = updateConfigPath();
  if (!config) return undefined;
  let feedUrl: string | undefined;
  try {
    feedUrl = feedUrlFrom(readFileSync(config, "utf8"));
  } catch {
    feedUrl = undefined;
  }
  const { autoUpdater } = await electronUpdater();
  const log = context.log ?? (() => {});
  autoUpdater.logger = { info: (m: unknown) => log(`updater: ${String(m)}`), warn: (m: unknown) => log(`updater warn: ${String(m)}`), error: (m: unknown) => log(`updater error: ${String(m)}`), debug: () => {} };
  return new UpdateController({ ...context, feedUrl, updater: autoUpdater as unknown as Updater });
}
