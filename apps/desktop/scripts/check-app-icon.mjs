#!/usr/bin/env node
// `pnpm check:icon [path/to/App.app]`: a headless check that a packaged app has its icon, since the
// Dock can't be inspected by computer use. Info.plist must name CFBundleIconFile, the .icns must be
// in Contents/Resources, and it must hold every size macOS asks for (16–512 pt at @1x and @2x,
// listed with iconutil). Default: the first .app under dist/release or dist/dev. macOS only.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("check-app-icon needs macOS (plutil, iconutil, sips).");

const root = resolve(import.meta.dirname, "..");
function findApp() {
  for (const flavor of ["release", "dev"]) {
    const dir = join(root, "dist", flavor);
    if (!existsSync(dir)) continue;
    for (const sub of readdirSync(dir).filter((d) => d.startsWith("mac"))) {
      const app = readdirSync(join(dir, sub)).find((f) => f.endsWith(".app"));
      if (app) return join(dir, sub, app);
    }
  }
  return undefined;
}

const app = process.argv[2] ? resolve(process.argv[2]) : findApp();
if (!app || !existsSync(app)) throw new Error(`No app to check (${app ?? "nothing under dist/"}). Run pnpm package first, or pass a path.`);

const problems = [];
const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8" }));
const iconName = plist.CFBundleIconFile;
if (typeof iconName !== "string" || !iconName) problems.push("Info.plist has no CFBundleIconFile");

const EXPECTED = [16, 32, 128, 256, 512].flatMap((pt) => [`icon_${pt}x${pt}.png:${pt}`, `icon_${pt}x${pt}@2x.png:${pt * 2}`]);
let found = [];
if (iconName) {
  const file = join(app, "Contents", "Resources", iconName.endsWith(".icns") ? iconName : `${iconName}.icns`);
  if (!existsSync(file)) {
    problems.push(`${file} is missing`);
  } else {
    const tmp = mkdtempSync(join(tmpdir(), "everyapp-icon-check-"));
    try {
      const iconset = join(tmp, "icon.iconset");
      execFileSync("iconutil", ["-c", "iconset", file, "-o", iconset]);
      found = readdirSync(iconset)
        .filter((f) => f.endsWith(".png"))
        .sort()
        .map((f) => {
          const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(iconset, f)], { encoding: "utf8" });
          const w = Number(/pixelWidth: (\d+)/.exec(out)?.[1]);
          const h = Number(/pixelHeight: (\d+)/.exec(out)?.[1]);
          if (w !== h) problems.push(`${f} isn't square (${w}×${h})`);
          return `${f}:${w}`;
        });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    for (const want of EXPECTED) if (!found.includes(want)) problems.push(`missing ${want.replace(":", " at ")} px`);
  }
}

console.log(`${app}\n  CFBundleIconFile: ${iconName ?? "(none)"}\n  sizes: ${found.map((f) => f.replace(".png", "").replace(":", " = ") + "px").join(", ") || "(none)"}`);
if (problems.length) {
  console.error(`✗ icon check failed:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("✓ icon check passed");
