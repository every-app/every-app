// Where things are, per build flavor. A "dev" flavor is `electron-vite dev` or a local package
// ("Every App Dev", com.everyapp.desktop.dev); a release is "Every App" (com.everyapp.desktop).
// The names themselves are in identity.json (src/main/identity.ts).

import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flavor, helperIdentity } from "./identity";

export const isDevFlavor = (): boolean => flavor === "dev";

/** The helper: always the bundled Contents/MacOS/everyapp-helper when packaged (what TCC and the
 * signature cover). Unpackaged: EVERYAPP_DESKTOP_HELPER_PATH, else the fake helper script. */
export function helperPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "..", "MacOS", helperIdentity.binary);
  return process.env.EVERYAPP_DESKTOP_HELPER_PATH || join(app.getAppPath(), "scripts", "fake-helper.mjs");
}

/** electron-builder writes app-update.yml only when a feed URL was given at build time
 * (EVERYAPP_DESKTOP_UPDATE_URL); without it the updater stays off. */
export function updateConfigPath(): string | undefined {
  if (!app.isPackaged || isDevFlavor()) return undefined;
  const path = join(process.resourcesPath, "app-update.yml");
  return existsSync(path) ? path : undefined;
}

/** Dev only: sign in with a pasted token at launch, for `everyapp dev` (stub mode takes any
 * bearer). From EVERYAPP_DESKTOP_DEV_APP_URL + EVERYAPP_DESKTOP_DEV_TOKEN, or `dev-signin.json` ({ appUrl, token }) in
 * userData, which `pnpm package:local` writes. Never read in a release build. */
export function devSignIn(): { appUrl: string; token: string } | undefined {
  if (!isDevFlavor()) return undefined;
  const { EVERYAPP_DESKTOP_DEV_APP_URL: appUrl, EVERYAPP_DESKTOP_DEV_TOKEN: token } = process.env;
  if (appUrl && token) return { appUrl, token };
  const file = join(app.getPath("userData"), "dev-signin.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { appUrl?: unknown; token?: unknown };
    if (typeof parsed.appUrl === "string" && typeof parsed.token === "string") {
      return { appUrl: parsed.appUrl, token: parsed.token };
    }
  } catch {
    // Ignore a broken file.
  }
  return undefined;
}

export const POLL_INTERVAL_MS = 5 * 60_000;

/** Dev builds keep the Keychain out of it entirely. A rebuilt Every App Dev is signed differently from
 * the build that made its "Every App Dev Safe Storage" item, so touching safeStorage can bring up a
 * Keychain password dialog (and block the main process until it's answered), which stops a
 * computer-use tester. So a dev build never reads or writes safeStorage: every sign-in, a pasted
 * token or OAuth, lasts until quit. EVERYAPP_DESKTOP_DEV_KEYCHAIN=1 opts back in (to test the stored sign-in),
 * unless a dev sign-in (EVERYAPP_DESKTOP_DEV_APP_URL + EVERYAPP_DESKTOP_DEV_TOKEN, or dev-signin.json) is in use or
 * EVERYAPP_DESKTOP_DEV_NO_KEYCHAIN=1 is set. Release builds always use the Keychain. */
export function keychainDisabled(): boolean {
  if (!isDevFlavor()) return false;
  if (process.env.EVERYAPP_DESKTOP_DEV_NO_KEYCHAIN === "1" || devSignIn() !== undefined) return true;
  return process.env.EVERYAPP_DESKTOP_DEV_KEYCHAIN !== "1";
}
