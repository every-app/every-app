#!/usr/bin/env node
// `pnpm icons`: makes Every App's icons. The output is committed.
//
//   build/icon.icns                     the app icon: Every App's logo (the pine tree,
//                                       build/icon-source.png, the same image as the site's
//                                       android-chrome-512x512.png) cut to the macOS rounded
//                                       square: an 824 pt body on the 1024 pt grid. Runs
//                                       anywhere (sharp);
//                                       electron-builder picks up build/icon.icns by itself.
//                                       A larger source (1024 px or more) makes the largest
//                                       size sharper: replace icon-source.png and run this.
//   resources/tray/*Template{,@2x}.png  the menu-bar icons (16 pt, @1x and @2x), template images
//                                       (black + alpha; macOS tints them for the menu bar):
//                                       idle = waveform, recording = filled square with the
//                                       waveform cut out, attention = waveform with a dot.
//                                       macOS only (sips); skipped elsewhere.
//
// sips rasterizes an SVG at its viewBox size, so each tray size gets its own SVG with a scale
// transform, and the tray shapes are even-odd paths rather than masks (masks come out soft).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const buildDir = join(root, "build");

// ── App icon (1024 grid; the body is the 824 pt macOS rounded square) ─────────────────────────
const GRID = 1024;
const BODY = 824;
const INSET = (GRID - BODY) / 2;
const RADIUS = 185;

const bodyMask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BODY}" height="${BODY}"><rect width="${BODY}" height="${BODY}" rx="${RADIUS}"/></svg>`,
);
// Two steps: sharp drops the alpha channel after compositing if both are asked for in one pipeline.
const square = await sharp(join(buildDir, "icon-source.png")).resize(BODY, BODY, { kernel: "lanczos3" }).removeAlpha().png().toBuffer();
const body = await sharp(square)
  .ensureAlpha()
  .composite([{ input: bodyMask, blend: "dest-in" }])
  .png()
  .toBuffer();
const master = await sharp({ create: { width: GRID, height: GRID, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: body, left: INSET, top: INSET }])
  .png()
  .toBuffer();

const sized = (px) => (px === GRID ? sharp(master) : sharp(master).resize(px, px, { kernel: "lanczos3" }));

/** The .icns run-length coding: a control byte below 128 copies n+1 bytes, else repeats the next byte n-125 times. */
function packRuns(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let run = 1;
    while (i + run < bytes.length && run < 130 && bytes[i + run] === bytes[i]) run++;
    if (run >= 3) {
      out.push(run + 125, bytes[i]);
      i += run;
      continue;
    }
    const start = i;
    while (i < bytes.length && i - start < 128) {
      if (i + 2 < bytes.length && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2]) break;
      i++;
    }
    out.push(i - start - 1, ...bytes.subarray(start, i));
  }
  return Buffer.from(out);
}

/** The 16 and 32 px entries as iconutil writes them: "ARGB", then each channel run-length coded. */
async function argb(px) {
  const rgba = await sized(px).raw().toBuffer();
  const channel = (offset) => packRuns(Uint8Array.from({ length: px * px }, (_, i) => rgba[i * 4 + offset]));
  return Buffer.concat([Buffer.from("ARGB"), channel(3), channel(0), channel(1), channel(2)]);
}
const png = (px) => sized(px).png({ compressionLevel: 9 }).toBuffer();

// The entries iconutil writes for a full iconset: 16, 32, 128, 256 and 512 pt, each @1x and @2x.
const entries = [
  ["ic12", await png(64)], // 32 pt @2x
  ["ic07", await png(128)],
  ["ic13", await png(256)], // 128 pt @2x
  ["ic08", await png(256)],
  ["ic04", await argb(16)],
  ["ic14", await png(512)], // 256 pt @2x
  ["ic09", await png(512)],
  ["ic05", await argb(32)],
  ["ic10", await png(1024)], // 512 pt @2x
  ["ic11", await png(32)], // 16 pt @2x
].map(([type, data]) => {
  const header = Buffer.alloc(8);
  header.write(type, "latin1");
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", "latin1");
icnsHeader.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
writeFileSync(join(buildDir, "icon.icns"), Buffer.concat([icnsHeader, ...entries]));
console.log(`wrote ${join(buildDir, "icon.icns")}`);

if (process.platform !== "darwin") {
  console.log("skipped the tray icons: they need macOS (sips)");
  process.exit(0);
}

// ── Tray icons (16 pt) ─────────────────────────────────────────────────────────────────────────
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
console.log(`wrote ${trayDir}`);
