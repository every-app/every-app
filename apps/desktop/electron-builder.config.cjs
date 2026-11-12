// electron-builder config. Everything that differs per machine comes from the environment:
//
// The names (bundle ids, URL schemes, the storage name, the helper) are identity.json's.
//
//   EVERYAPP_DESKTOP_FLAVOR=dev            "Every App Dev" (com.everyapp.desktop.dev, everyapp-dev://), never signed here:
//                              scripts/package-local.mjs signs it with a stable local identity.
//   EVERYAPP_DESKTOP_HELPER_BINARY=path    the everyapp-helper to put at Contents/MacOS/everyapp-helper
//                              (else mac/.build/helper/everyapp-helper if it exists, else none).
//   EVERYAPP_DESKTOP_UPDATE_URL=url        the update feed (generic provider). Unset: no app-update.yml, so the
//                              updater stays off.
//   Signing (release):         CSC_NAME (a Keychain identity) or CSC_LINK + CSC_KEY_PASSWORD.
//                              None set: ad hoc.
//   Notarizing (release):      APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID +
//                              APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. None set: skipped.

const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

const env = process.env;
const identity = require("./identity.json");
const dev = env.EVERYAPP_DESKTOP_FLAVOR === "dev";
const { productName, appId, scheme, storageName } = dev ? identity.dev : identity.release;
const helperName = identity.helper.binary;

const defaultHelper = resolve(__dirname, "mac", ".build", "helper", helperName);
const helper = env.EVERYAPP_DESKTOP_HELPER_BINARY || (existsSync(defaultHelper) ? defaultHelper : undefined);
if (helper && !existsSync(helper)) throw new Error(`EVERYAPP_DESKTOP_HELPER_BINARY not found: ${helper}`);
if (!helper) console.warn("electron-builder: no everyapp-helper to bundle; the app will say the recorder isn't installed.");
// A release ships the real universal helper (scripts/release-helper.mjs builds it). Refuse anything else.
if (!dev && process.platform === "darwin") {
  if (!helper) throw new Error("A release build needs the real everyapp-helper: run it through `pnpm package` / `pnpm dist`.");
  const archs = require("node:child_process").execFileSync("lipo", ["-archs", helper], { encoding: "utf8" }).trim().split(/\s+/);
  if (!archs.includes("arm64") || !archs.includes("x86_64")) {
    throw new Error(`The release everyapp-helper must be universal (arm64 + x86_64); ${helper} has ${archs.join(", ")}.`);
  }
}

/** Usage strings Electron's template adds that Every App doesn't need (see afterPack). */
const UNUSED_USAGE_KEYS = ["NSCameraUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"];

const hasSigningIdentity = !!(env.CSC_NAME || env.CSC_LINK);
const canNotarize = !!(
  (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
  (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId,
  productName,
  directories: { output: dev ? "dist/dev" : "dist/release", buildResources: "build" },
  files: ["out/**", "resources/**", "package.json"],
  // The packaged package.json's productName is what Electron calls the app as it starts, which
  // names safeStorage's Keychain item. It's the fixed storageName, so a new display name never
  // changes it (src/main/identity.ts). The bundle and menus still show productName.
  extraMetadata: { productName: storageName },
  asar: true,
  extraFiles: helper ? [{ from: helper, to: `MacOS/${helperName}` }] : [],
  // The fake helper (a script) needs its source beside the wrapper; harmless otherwise.
  extraResources: dev && env.EVERYAPP_DESKTOP_FAKE_HELPER === "1" ? [{ from: "scripts/fake-helper.mjs", to: "fake-helper.mjs" }] : [],
  protocols: [{ name: productName, schemes: [scheme] }],
  publish: env.EVERYAPP_DESKTOP_UPDATE_URL && !dev ? [{ provider: "generic", url: env.EVERYAPP_DESKTOP_UPDATE_URL }] : null,
  // Release: no running as Node, no inspector flags, only the signed asar. Dev keeps RunAsNode,
  // which the fake helper's wrapper uses.
  electronFuses: dev
    ? undefined
    : {
        runAsNode: false,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
      },
  // Electron's ~40 other UI languages; Every App is English only.
  electronLanguages: ["en"],
  // Release file names without the display name (no spaces, unchanged by a rename):
  // EveryApp-1.2.3-arm64-mac.zip, EveryApp-1.2.3-x64.dmg.
  mac: {
    artifactName: "EveryApp-${version}-${arch}-mac.${ext}",
    category: "public.app-category.productivity",
    icon: join("build", "icon.icns"),
    minimumSystemVersion: "15.0",
    target: dev
      ? [{ target: "dir" }]
      : [
          // One build per architecture: a universal one carries two copies of Electron (about twice the
          // download). electron-updater picks the file with "arm64" in its name on Apple Silicon.
          { target: "dmg", arch: ["arm64", "x64"] },
          // electron-updater on macOS installs from the zip.
          { target: "zip", arch: ["arm64", "x64"] },
        ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    // Without a Team ID (ad hoc), library validation would refuse Electron's own frameworks.
    entitlements: join("build", hasSigningIdentity ? "entitlements.mac.plist" : "entitlements.dev.plist"),
    entitlementsInherit: join("build", hasSigningIdentity ? "entitlements.mac.inherit.plist" : "entitlements.dev.plist"),
    // Dev: unsigned here (package-local signs). Release without an identity: ad hoc.
    identity: dev ? null : hasSigningIdentity ? undefined : "-",
    notarize: !dev && hasSigningIdentity && canNotarize,
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Scribe transcribes your side of a meeting while you record it. Audio is never saved.",
      NSAudioCaptureUsageDescription:
        "Scribe transcribes the other side of a meeting from your Mac's sound while you record it. Audio is never saved.",
      LSApplicationCategoryType: "public.app-category.productivity",
    },
  },
  dmg: { title: productName, artifactName: "EveryApp-${version}-${arch}.${ext}" },
  // Electron's own Info.plist asks for the camera and Bluetooth, which Every App never uses: drop those
  // usage strings so only the mic and audio capture appear. Runs before signing.
  afterPack: async (context) => {
    if (context.electronPlatformName !== "darwin") return;
    const plist = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Info.plist");
    for (const key of UNUSED_USAGE_KEYS) {
      try {
        require("node:child_process").execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "ignore" });
      } catch {
        // Not there: nothing to drop.
      }
    }
  },
};
