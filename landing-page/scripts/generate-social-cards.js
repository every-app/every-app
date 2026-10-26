#!/usr/bin/env node

// Renders the share cards that buildPageSeo (src/lib/seo.ts) points pages at:
// the home card, which every page without a title card shares, and the title
// cards. Runs after the prerender, so the built HTML is the single source of
// truth for title cards: every page whose og:image is under /og/ (other than
// the home card) gets a PNG with its og:image:alt text as the title.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { render } from "takumi-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "../dist/client");
const HOME_CARD_PATH = "/og/home.png";

function readImage(file) {
  return `data:image/png;base64,${readFileSync(
    join(__dirname, "../public", file),
  ).toString("base64")}`;
}

const LOGO = readImage("android-chrome-192x192.png");
const TRANSPARENT_LOGO = readImage("transparent-logo-256.png");

function readMeta(html, property) {
  const match = html.match(
    new RegExp(`<meta property="${property}" content="([^"]*)"`),
  );
  return match ? decodeEntities(match[1]) : null;
}

// React escapes attribute values with exactly these entities.
function decodeEntities(value) {
  return value
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Matches the home page hero (src/routes/index.tsx).
function homeCard() {
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 80,
        backgroundColor: "#0a0f0d",
        color: "#ffffff",
      },
    },
    h("img", {
      src: TRANSPARENT_LOGO,
      width: 128,
      height: 128,
      style: { position: "absolute", top: 32, left: 50, opacity: 0.8 },
    }),
    h(
      "div",
      {
        style: {
          fontSize: 168,
          fontWeight: 700,
          letterSpacing: -5,
          lineHeight: 1,
        },
      },
      "EveryApp",
    ),
    h(
      "div",
      { style: { marginTop: 32, fontSize: 52, fontWeight: 400 } },
      "Make every app open source",
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          right: 64,
          bottom: 28,
          fontSize: 24,
          color: "#a8a29e",
        },
      },
      "everyapp.com",
    ),
  );
}

function titleCard(title) {
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        padding: 64,
        backgroundColor: "#000000",
        color: "#ffffff",
      },
    },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 20 } },
      h("img", {
        src: LOGO,
        width: 64,
        height: 64,
        style: { borderRadius: 14 },
      }),
      h(
        "div",
        { style: { fontSize: 34, fontWeight: 600, letterSpacing: -1 } },
        "EveryApp",
      ),
    ),
    h(
      "div",
      {
        style: {
          display: "flex",
          flex: 1,
          alignItems: "center",
          paddingTop: 24,
        },
      },
      h(
        "div",
        {
          style: {
            fontSize: title.length > 85 ? 54 : title.length > 48 ? 64 : 80,
            fontWeight: 700,
            letterSpacing: -2,
            lineHeight: 1.12,
            overflowWrap: "anywhere",
          },
        },
        title,
      ),
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          right: 64,
          bottom: 28,
          fontSize: 24,
          color: "#a3a3a3",
        },
      },
      "everyapp.com",
    ),
  );
}

async function writeCard(pathname, element) {
  const png = await render(element, {
    width: 1200,
    height: 630,
    format: "png",
    emoji: "from-font",
  });
  const outFile = join(DIST_DIR, pathname);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, png);
}

await writeCard(HOME_CARD_PATH, homeCard());

const cards = new Map();
const htmlFiles = readdirSync(DIST_DIR, { recursive: true }).filter((file) =>
  file.endsWith(".html"),
);
for (const file of htmlFiles) {
  const html = readFileSync(join(DIST_DIR, file), "utf8");
  const image = readMeta(html, "og:image");
  const title = readMeta(html, "og:image:alt");
  if (!image || !title) continue;
  const { pathname } = new URL(image);
  if (pathname.startsWith("/og/") && pathname !== HOME_CARD_PATH) {
    cards.set(pathname, title);
  }
}

for (const [pathname, title] of cards) {
  await writeCard(pathname, titleCard(title));
}

console.log(`Generated the home card and ${cards.size} title cards`);
