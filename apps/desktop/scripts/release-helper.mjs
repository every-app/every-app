#!/usr/bin/env node
// Before `pnpm package` / `pnpm dist`: a release always bundles the real, universal helper.
// EVERYAPP_DESKTOP_HELPER_BINARY (a prebuilt one, e.g. signed with a Developer ID) is checked; otherwise
// mac/scripts/build-helper.sh builds it for arm64 + x86_64 into mac/.build/helper/everyapp-helper,
// which electron-builder.config.cjs bundles. EVERYAPP_DESKTOP_HELPER_ARCHS is ignored here on purpose.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("A release build needs macOS (the helper is Swift).");
const root = resolve(import.meta.dirname, "..");

let helper = process.env.EVERYAPP_DESKTOP_HELPER_BINARY;
if (helper) {
  helper = resolve(helper);
  if (!existsSync(helper)) throw new Error(`EVERYAPP_DESKTOP_HELPER_BINARY not found: ${helper}`);
  console.log(`▸ release helper: ${helper}`);
} else {
  console.log("▸ building the universal everyapp-helper (mac/scripts/build-helper.sh)");
  const out = execFileSync("bash", [resolve(root, "mac", "scripts", "build-helper.sh")], {
    cwd: root,
    env: { ...process.env, EVERYAPP_DESKTOP_HELPER_ARCHS: "arm64 x86_64" },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  helper = out.trim().split("\n").pop();
}
const archs = execFileSync("lipo", ["-archs", helper], { encoding: "utf8" }).trim().split(/\s+/);
if (!archs.includes("arm64") || !archs.includes("x86_64")) {
  throw new Error(`The release helper must be universal (arm64 + x86_64); ${helper} has ${archs.join(", ")}.`);
}
console.log(`▸ helper archs: ${archs.join(" ")}`);
