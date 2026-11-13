// The real electron-updater, loaded the way the built main bundle loads it: updaterModule.ts run
// by plain Node, because vitest's own import() adds the named exports Node leaves out and would
// pass either way. Every other updates test injects a fake updater, so none of them runs this
// line: up to 0.1.8 it returned undefined and no release could update itself.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const desktop = resolve(import.meta.dirname, "..");
const node = (script: string) => execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: desktop, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("electron-updater's autoUpdater is on the object the main process reads it from", () => {
  const module = pathToFileURL(resolve(desktop, "src/main/updaterModule.ts")).href;
  // The getter isn't called: it makes the platform's updater, which needs Electron.
  const found = node(`
    const { electronUpdater } = await import(${JSON.stringify(module)});
    console.log(typeof Object.getOwnPropertyDescriptor(await electronUpdater(), "autoUpdater")?.get);
  `);
  expect(found).toBe("function");
});
