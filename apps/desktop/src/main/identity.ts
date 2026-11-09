// Which build this is and its fixed names (identity.json). Import this before anything reads
// userData, the logs path or safeStorage: index.ts pins them at startup with pinStorage().

import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import identity from "../../identity.json";

export type Flavor = "dev" | "release";

// The name Electron starts with: the packaged package.json's productName, which
// electron-builder.config.cjs sets to the flavor's storageName.
const initialName = app.getName();

/** Unpackaged runs (`pnpm dev`, e2e) and the "Every App Dev" package are dev; the rest release. */
export const flavor: Flavor =
  !app.isPackaged || initialName === identity.dev.storageName || initialName === identity.dev.productName ? "dev" : "release";

export const names = flavor === "dev" ? identity.dev : identity.release;
export const helperIdentity = identity.helper;

/** The URL schemes this build owns. A dev build owns only `everyapp-dev`, so it never takes links
 * meant for the installed Every App. */
export const urlSchemes: readonly string[] = [names.scheme];

/**
 * Pins where local state lives to fixed names, never to the display name, so renaming the app
 * (productName) can't lose local data or sign anyone out:
 * - userData: ~/Library/Application Support/<storageName> (settings, sign-in, pending uploads)
 * - logs: ~/Library/Logs/<storageName>
 * - safeStorage's Keychain item: "<storageName> Safe Storage". Electron names it after app.name
 *   when the app starts; the packaged package.json's productName is storageName, and this sets it
 *   again for unpackaged runs. The display name comes back once that's done (restoreDisplayName).
 *
 * An explicit --user-data-dir (a test driver's throwaway profile) wins, with its logs inside it.
 */
export function pinStorage(): void {
  app.setName(names.storageName);
  if (app.commandLine.hasSwitch("user-data-dir")) {
    app.setAppLogsPath(join(app.getPath("userData"), "logs"));
    return;
  }
  app.setPath("userData", join(app.getPath("appData"), names.storageName));
  // macOS keeps logs in ~/Library/Logs; elsewhere (Linux CI, e2e) they stay in the profile.
  app.setAppLogsPath(
    process.platform === "darwin" ? join(homedir(), "Library", "Logs", names.storageName) : join(app.getPath("userData"), "logs"),
  );
}

/** After ready (the Keychain name is fixed by then): menus, About and dialogs say the display name. */
export function restoreDisplayName(): void {
  app.setName(names.productName);
}
