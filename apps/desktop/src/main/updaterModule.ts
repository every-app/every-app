// Loads electron-updater for the main bundle, which is CommonJS and keeps this as a real import().
// electron-updater is CommonJS too and defines `autoUpdater` with a getter, which Node doesn't list
// as a named export: import() gives it only on `default` (module.exports). Destructuring it from
// the namespace gave undefined in every release up to 0.1.8. No Electron import and only type
// syntax Node can strip, so test/updater-module.test.ts runs this file in plain Node.

type ElectronUpdater = typeof import("electron-updater");

/** The electron-updater object that has `autoUpdater` on it. Reading `.autoUpdater` makes the
 * platform's updater, which needs Electron, so callers read it and tests only look for it. */
export async function electronUpdater(): Promise<ElectronUpdater> {
  const loaded: { default?: object } = await import("electron-updater");
  const found = [loaded, loaded.default].find((m) => m !== undefined && "autoUpdater" in m);
  if (!found) throw new Error("electron-updater loaded without autoUpdater");
  return found as ElectronUpdater;
}
