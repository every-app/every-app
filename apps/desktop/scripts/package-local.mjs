#!/usr/bin/env node
// `pnpm package:local`: a packaged "Every App Dev" for local testing (a person or a computer-use
// agent clicking through the real app). No Apple Developer ID needed.
//
// 1. Builds the app as "Every App Dev" (com.everyapp.desktop.dev, everyapp-dev://; identity.json), so it
//    never collides with an installed Every App (com.everyapp.desktop) in TCC, Launch Services, the
//    Keychain or its local data.
// 2. Bundles Contents/MacOS/everyapp-helper: EVERYAPP_DESKTOP_HELPER_PATH if set (a built everyapp-helper binary);
//    else, by default, the real one, built first with mac/scripts/build-helper.sh (this Mac's arch
//    only unless EVERYAPP_DESKTOP_HELPER_ARCHS says otherwise). The fake helper (a wrapper that runs
//    scripts/fake-helper.mjs) only on request: EVERYAPP_DESKTOP_FAKE_HELPER=1 or EVERYAPP_DESKTOP_HELPER=fake.
// 3. Signs helper and app with a stable identity: EVERYAPP_DESKTOP_SIGN_ID, else the self-signed "Scrawl Dev"
//    if this Mac has it, else ad hoc. A stable identity keeps mic/system-audio grants across
//    rebuilds. No notarization.
// 4. Installs to ~/Applications/Every App Dev.app (quitting a running one first) and launches it,
//    unless EVERYAPP_DESKTOP_NO_LAUNCH=1.
// 5. With EVERYAPP_DESKTOP_DEV_APP_URL + EVERYAPP_DESKTOP_DEV_TOKEN set, writes the dev sign-in file so the app starts
//    signed in (e.g. http://talk.localhost:8787 + any token against `everyapp dev` in stub mode).
//    EVERYAPP_DESKTOP_DEV_FRESH=1 instead launches it on a brand-new temp profile (first run, no sign-in, no
//    settings), deleted on quit; the normal Every App Dev profile isn't touched.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // Some shells (Electron-based terminals) set it; it breaks electron tooling.
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, env, ...opts });
const step = (s) => console.log(`\n▸ ${s}`);

const ids = createRequire(import.meta.url)("../identity.json");
const PRODUCT = ids.dev.productName;
const APP_ID = ids.dev.appId;
const HELPER_NAME = ids.helper.binary;
const HELPER_ID = ids.helper.bundleId;

// 1–2. Build, with the helper.
const builderEnv = { EVERYAPP_DESKTOP_FLAVOR: "dev" };
let realHelper = false;
const wantFake = env.EVERYAPP_DESKTOP_FAKE_HELPER === "1" || env.EVERYAPP_DESKTOP_HELPER === "fake";
if (!env.EVERYAPP_DESKTOP_HELPER_PATH && !wantFake) {
  if (process.platform !== "darwin") throw new Error("The real helper builds only on macOS; set EVERYAPP_DESKTOP_FAKE_HELPER=1 for the fake one.");
  step("building everyapp-helper (mac/scripts/build-helper.sh)");
  const script = resolve(root, "mac", "scripts", "build-helper.sh");
  const archs = env.EVERYAPP_DESKTOP_HELPER_ARCHS ?? (process.arch === "arm64" ? "arm64" : "x86_64");
  const out = execFileSync(script, [], { cwd: root, env: { ...env, EVERYAPP_DESKTOP_HELPER_ARCHS: archs }, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  env.EVERYAPP_DESKTOP_HELPER_PATH = out.trim().split("\n").pop();
}
if (env.EVERYAPP_DESKTOP_HELPER_PATH) {
  realHelper = true;
  const helper = resolve(env.EVERYAPP_DESKTOP_HELPER_PATH);
  if (!existsSync(helper)) throw new Error(`EVERYAPP_DESKTOP_HELPER_PATH not found: ${helper}`);
  if (/\.(c|m)?js$/.test(helper)) throw new Error("EVERYAPP_DESKTOP_HELPER_PATH must be a binary for a package; leave it unset for the fake helper.");
  builderEnv.EVERYAPP_DESKTOP_HELPER_BINARY = helper;
  step(`bundling the helper from ${helper}`);
} else {
  const dir = join(root, "dist", "fake-helper");
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, HELPER_NAME);
  // Electron runs the fake helper as Node (the RunAsNode fuse stays on in dev builds).
  writeFileSync(
    wrapper,
    `#!/bin/sh\n# ${PRODUCT}'s stand-in recorder: scripts/fake-helper.mjs run by Electron as Node.\nDIR="$(cd "$(dirname "$0")" && pwd)"\nELECTRON_RUN_AS_NODE=1 exec "$DIR/${PRODUCT}" "$DIR/../Resources/fake-helper.mjs"\n`,
  );
  chmodSync(wrapper, 0o755);
  builderEnv.EVERYAPP_DESKTOP_HELPER_BINARY = wrapper;
  builderEnv.EVERYAPP_DESKTOP_FAKE_HELPER = "1";
  step("bundling the fake helper (EVERYAPP_DESKTOP_FAKE_HELPER=1 / EVERYAPP_DESKTOP_HELPER=fake)");
}

step("electron-vite build");
run("pnpm", ["exec", "electron-vite", "build"]);
step("electron-builder (dir, unsigned)");
rmSync(join(root, "dist", "dev"), { recursive: true, force: true });
run("pnpm", ["exec", "electron-builder", "--config", "electron-builder.config.cjs", "--mac", "--dir"], {
  env: { ...env, ...builderEnv, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});

const outDir = join(root, "dist", "dev");
const built = readdirSync(outDir)
  .filter((d) => d.startsWith("mac"))
  .map((d) => join(outDir, d, `${PRODUCT}.app`))
  .find(existsSync);
if (!built) throw new Error(`No ${PRODUCT}.app under ${outDir}`);

// 3. Sign, inside out.
function identity() {
  if (env.EVERYAPP_DESKTOP_SIGN_ID) return env.EVERYAPP_DESKTOP_SIGN_ID;
  const list = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).stdout ?? "";
  return list.includes('"Scrawl Dev"') ? "Scrawl Dev" : "-";
}
const id = identity();
step(`signing with ${id === "-" ? "an ad hoc signature (grants reset every rebuild)" : `"${id}"`}`);
const entitlements = join(root, "build", "entitlements.dev.plist");
const sign = (path, extra = []) =>
  run("codesign", ["--force", "--options", "runtime", "--timestamp=none", "--entitlements", entitlements, ...extra, "--sign", id, path], {
    stdio: ["ignore", "ignore", "inherit"],
  });
const frameworks = join(built, "Contents", "Frameworks");
for (const item of readdirSync(frameworks)) sign(join(frameworks, item), ["--deep"]);
const helperPath = join(built, "Contents", "MacOS", HELPER_NAME);
// The real helper keeps its own entitlements (audio-input) and embedded Info.plist; only the
// signature is redone, so it matches the app's.
if (existsSync(helperPath)) {
  if (realHelper) {
    run("codesign", ["--force", "--options", "runtime", "--timestamp=none", "--preserve-metadata=entitlements,identifier,flags", "--sign", id, helperPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } else {
    sign(helperPath, ["--identifier", HELPER_ID]);
  }
}
sign(built);
run("codesign", ["--verify", "--deep", "--strict", built]);

// 4. Install and launch.
const apps = join(homedir(), "Applications");
const target = join(apps, `${PRODUCT}.app`);
step(`installing ${target}`);
// Only when it's running: `tell application … to quit` launches an app that isn't.
if (spawnSync("pgrep", ["-x", PRODUCT]).status === 0) {
  spawnSync("osascript", ["-e", `if application id "${APP_ID}" is running then tell application id "${APP_ID}" to quit`], { stdio: "ignore" });
}
for (let i = 0; i < 50 && spawnSync("pgrep", ["-x", PRODUCT]).status === 0; i++) spawnSync("sleep", ["0.2"]);
spawnSync("pkill", ["-x", PRODUCT]);
mkdirSync(apps, { recursive: true });
rmSync(target, { recursive: true, force: true });
run("ditto", [built, target]);

// 5. Dev sign-in (not for a fresh run: EVERYAPP_DESKTOP_DEV_FRESH=1 starts on a new, empty profile, and the
//    normal profile is left alone).
const fresh = env.EVERYAPP_DESKTOP_DEV_FRESH === "1";
if (fresh) step("EVERYAPP_DESKTOP_DEV_FRESH=1: this launch starts on a brand-new profile (deleted on quit); no dev sign-in written");
if (env.EVERYAPP_DESKTOP_DEV_APP_URL && env.EVERYAPP_DESKTOP_DEV_TOKEN && !fresh) {
  // userData is pinned to the storage name, not the display name (src/main/identity.ts).
  const userData = join(homedir(), "Library", "Application Support", ids.dev.storageName);
  mkdirSync(userData, { recursive: true });
  const file = join(userData, "dev-signin.json");
  writeFileSync(file, JSON.stringify({ appUrl: env.EVERYAPP_DESKTOP_DEV_APP_URL, token: env.EVERYAPP_DESKTOP_DEV_TOKEN }), { mode: 0o600 });
  step(`wrote the dev sign-in for ${env.EVERYAPP_DESKTOP_DEV_APP_URL} (${file})`);
}

if (env.EVERYAPP_DESKTOP_NO_LAUNCH === "1") {
  console.log(`\nInstalled ${target} (not launched).`);
} else {
  // `open` hands its environment to the app; keep build-time variables out of it (EVERYAPP_DESKTOP_DEV_FRESH
  // stays: the app reads it at launch).
  const launchEnv = { ...env };
  for (const k of ["EVERYAPP_DESKTOP_HELPER_PATH", "EVERYAPP_DESKTOP_HELPER", "EVERYAPP_DESKTOP_FAKE_HELPER", "EVERYAPP_DESKTOP_HELPER_ARCHS", "EVERYAPP_DESKTOP_DEV_TOKEN", "EVERYAPP_DESKTOP_DEV_APP_URL"]) delete launchEnv[k];
  run("open", [target], { env: launchEnv });
  console.log(`\nLaunched ${target}.`);
}
