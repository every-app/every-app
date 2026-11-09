// Captures every playground scene at 1200×800 in light and dark mode into
// ui/screenshots/ (not committed). Run the playground first (pnpm playground), then
// `pnpm screenshots [scene-id …]`.
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.PLAYGROUND_URL ?? "http://127.0.0.1:5188/";
const out = fileURLToPath(new URL("../screenshots/", import.meta.url));
const only = process.argv.slice(2);
const themes = (process.env.THEMES ?? "light,dark").split(",");

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  await page.goto(`${base}?bare`);
  await page.waitForFunction(() => window.__DESKTOP_SCENES__);
  const all = await page.evaluate(() => window.__DESKTOP_SCENES__);
  const ids = only.length ? all.filter((id) => only.includes(id)) : all;
  for (const theme of themes) {
    for (const id of ids) {
      await page.goto(`${base}?scene=${id}&theme=${theme}&bare`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${out}${id}-${theme}.png` });
      console.log(`${id}-${theme}.png`);
    }
  }
} finally {
  await browser.close();
}
