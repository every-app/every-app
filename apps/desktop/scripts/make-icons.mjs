#!/usr/bin/env node
// `pnpm icons`: draws Every App's icons as SVG and rasterizes them with macOS's sips and iconutil.
// Run on a Mac after changing a design; the output is committed.
//
//   build/icon.svg, build/icon.icns     the app icon: a rounded square with a soft blue gradient
//                                       and a speech bubble holding a waveform. electron-builder
//                                       picks up build/icon.icns by itself.
//   resources/tray/*Template{,@2x}.png  the menu-bar icons (16 pt, @1x and @2x), template images
//                                       (black + alpha; macOS tints them for the menu bar):
//                                       idle = waveform, recording = filled square with the
//                                       waveform cut out, attention = waveform with a dot.
//
// sips rasterizes an SVG at its viewBox size, so each size gets its own SVG with a scale
// transform, and the tray shapes are even-odd paths rather than masks (masks come out soft).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("make-icons needs macOS (sips, iconutil).");

const root = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "everyapp-icons-"));

/** An SVG of `size` px whose content is drawn in a `unit`-sized coordinate space. */
const svg = (size, unit, body, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
  `<defs>${defs}</defs><g transform="scale(${size / unit})">${body}</g></svg>\n`;

function rasterize(svgText, out) {
  const src = join(tmp, `${Math.random().toString(36).slice(2)}.svg`);
  writeFileSync(src, svgText);
  execFileSync("sips", ["-s", "format", "png", src, "--out", out], { stdio: "ignore" });
}

/** A rounded rectangle as a path (for even-odd cut-outs). */
const rr = (x, y, w, h, r) => {
  r = Math.min(r, w / 2, h / 2);
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
};
const circle = (cx, cy, r) => `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;

// ── App icon (1024 grid; the body is the 824 pt macOS rounded square) ─────────────────────────
const appDefs = `
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8FA8FF"/><stop offset="1" stop-color="#4C5FD7"/></linearGradient>
  <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6F86F5"/><stop offset="1" stop-color="#4A5BD0"/></linearGradient>
  <radialGradient id="shine" cx="0.3" cy="0.15" r="0.9"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.28"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`;
const appBars = [
  [340, 444, 80],
  [418, 396, 176],
  [496, 350, 268],
  [574, 408, 152],
  [652, 452, 64],
];
const appBody = [
  `<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>`,
  `<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#shine)"/>`,
  `<path d="M332 292H692A92 92 0 0 1 784 384V584A92 92 0 0 1 692 676H468L372 752Q360 761 360 746V676H332A92 92 0 0 1 240 584V384A92 92 0 0 1 332 292Z" fill="#FFFFFF" fill-opacity="0.96"/>`,
  `<g fill="url(#bar)">${appBars.map(([x, y, h]) => `<rect x="${x}" y="${y}" width="44" height="${h}" rx="22"/>`).join("")}</g>`,
].join("");

const buildDir = join(root, "build");
writeFileSync(join(buildDir, "icon.svg"), svg(1024, 1024, appBody, appDefs));
const iconset = join(tmp, "icon.iconset");
mkdirSync(iconset);
for (const pt of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = pt * scale;
    rasterize(svg(px, 1024, appBody, appDefs), join(iconset, `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`));
  }
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);

// ── Tray icons (16 pt) ─────────────────────────────────────────────────────────────────────────
const waveBars = [
  [3, 4],
  [5.5, 8],
  [8, 11],
  [10.5, 7],
  [13, 4],
]; // [centerX, height], width 1.5
const wave = waveBars.map(([cx, h]) => rr(cx - 0.75, 8 - h / 2, 1.5, h, 0.75)).join("");
const smallWave = waveBars.map(([cx, h]) => rr(8 + (cx - 8) * 0.68 - 0.6, 8 - (h * 0.62) / 2, 1.2, h * 0.62, 0.6)).join("");
const tray = {
  idleTemplate: `<path d="${wave}" fill="#000"/>`,
  recordingTemplate: `<path d="${rr(1, 1, 14, 14, 4)}${smallWave}" fill="#000" fill-rule="evenodd"/>`,
  attentionTemplate: `<path d="${waveBars
    .slice(0, 4)
    .map(([cx, h]) => rr(cx - 0.75, 8 - h / 2, 1.5, h, 0.75))
    .join("")}${rr(12.25, 7, 1.5, 3, 0.75)}${circle(13.4, 3.1, 2.3)}" fill="#000"/>`,
};
const trayDir = join(root, "resources", "tray");
rmSync(trayDir, { recursive: true, force: true });
mkdirSync(trayDir, { recursive: true });
for (const [name, body] of Object.entries(tray)) {
  for (const scale of [1, 2]) rasterize(svg(16 * scale, 16, body), join(trayDir, `${name}${scale === 2 ? "@2x" : ""}.png`));
}

rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${join(buildDir, "icon.icns")}, ${join(buildDir, "icon.svg")} and ${trayDir}`);
