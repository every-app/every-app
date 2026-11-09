#!/usr/bin/env node
// Drives the built app (out/) against the mock API and captures each screen, light and dark:
//
//   pnpm build && node src/renderer/dev/mock-api.mjs &  node src/renderer/dev/drive.mjs [out-dir]
//
// The window renders the real renderer over the real preload and main; only /api/v1 is mocked.

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const out = process.argv[2] ?? join(tmpdir(), "everyapp-desktop-shots");
const apiUrl = process.env.EVERYAPP_DESKTOP_DEV_APP_URL ?? "http://127.0.0.1:8788";
await mkdir(out, { recursive: true });

const env = { ...process.env, EVERYAPP_DESKTOP_DEV_APP_URL: apiUrl, EVERYAPP_DESKTOP_DEV_TOKEN: "dev", FAKE_HELPER_LINE_MS: "1500" };
delete env.ELECTRON_RUN_AS_NODE;
// Its own userData, so it never takes the "Every App Dev" single-instance lock or touches the
// installed Every App Dev's settings.
const userData = join(tmpdir(), "everyapp-drive-userdata");
const app = await electron.launch({ executablePath: require("electron"), args: [".", `--user-data-dir=${userData}`], env });
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setSize(1200, 800);
  w.show();
});
await page.evaluate(() => localStorage.setItem("everyapp.onboarded", "1"));
await page.reload();
await page.waitForSelector("text=Coming up", { timeout: 15000 });

const shots = (process.env.SHOTS ?? "home,shared,folder,meeting,templates,settings,recording").split(",");
const go = async (hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForTimeout(900);
};

for (const theme of ["light", "dark"]) {
  await page.evaluate((t) => {
    localStorage.setItem("theme-preference", t);
    document.documentElement.setAttribute("data-theme", t === "dark" ? "openseo-dark" : "openseo");
  }, theme);
  for (const name of shots) {
    if (name === "recording") continue;
    const hash = { home: "#/", shared: "#/shared", folder: "#/folders/f-1", meeting: "#/meetings/m-2", templates: "#/templates?id=t-1", settings: "#/settings" }[name];
    await go(hash);
    await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
    console.log(`${name}-${theme}.png`);
  }
}

if (shots.includes("recording")) {
  await go("#/");
  await page.keyboard.press("Meta+n");
  await page.waitForURL(/#\/meetings\//, { timeout: 15000 });
  const notepad = page.getByRole("textbox", { name: "Your notes" });
  await notepad.click();
  await page.keyboard.type("- pricing for 40 seats\nask about SOC 2");
  await page.getByRole("button", { name: /Transcript/ }).click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(out, "recording-dark.png") });
  console.log("recording-dark.png");
  await page.getByRole("button", { name: /^Stop$/ }).click();
  await page.waitForTimeout(6500);
  await page.getByRole("tab", { name: "Your jottings" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, "after-recording-dark.png") });
  console.log("after-recording-dark.png");
}

await app.close();
