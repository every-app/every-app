#!/usr/bin/env node

// Renders the share cards that buildPageSeo (src/lib/seo.ts) points pages at:
// the home card, which every page without a title card shares, and the title
// cards. Runs after the prerender, so the built HTML is the single source of
// truth for title cards: every page whose og:image is under /og/ (other than
// the home card and the repository card) gets a PNG with its og:image:alt text
// as the title. The /openscribe page's card is laid out like the card GitHub
// draws for a shared repository link.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { render } from "takumi-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "../dist/client");
const HOME_CARD_PATH = "/og/home.png";
// OPENSCRIBE_CARD_PATH in src/lib/openscribe-data.ts.
const OPENSCRIBE_CARD_PATH = "/og/openscribe.png";
// Written by scripts/sync-openscribe-data.js, which the build runs first.
const OPENSCRIBE_REPO = JSON.parse(
  readFileSync(
    join(__dirname, "../src/lib/openscribe-data.generated.json"),
    "utf8",
  ),
).repos.openScribe;

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

// lucide's outlines (the site's icon set), not GitHub's Octicons.
function icon(shapes) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#636c76" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const ICONS = {
  contributors: icon(
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  ),
  issues: icon(
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  ),
  stars: icon(
    '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  ),
  forks: icon(
    '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
  ),
};

function repoStat(iconSrc, count, label) {
  return h(
    "div",
    { style: { display: "flex", gap: 14, marginRight: 64 } },
    h("img", { src: iconSrc, width: 34, height: 34, style: { marginTop: 3 } }),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column" } },
      h(
        "div",
        { style: { fontSize: 32, lineHeight: 1.25, color: "#1f2328" } },
        String(count),
      ),
      h(
        "div",
        { style: { fontSize: 24, lineHeight: 1.3, color: "#636c76" } },
        label,
      ),
    ),
  );
}

// The card GitHub draws for a shared repository link: owner/name, the
// description, the logo at the right, the counts, and the language bar along
// the bottom. Ours carries the tree logo and no GitHub mark. A repository
// that isn't public yet has no counts, so the row is left out.
function repoCard(repo) {
  const stats = repo.public
    ? [
        [ICONS.contributors, repo.contributors, "Contributors"],
        [ICONS.issues, repo.issues, "Issues"],
        [ICONS.stars, repo.stars, "Stars"],
        [ICONS.forks, repo.forks, "Forks"],
      ].filter(([, count]) => count !== null)
    : [];
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        padding: "84px 80px 0 80px",
        backgroundColor: "#ffffff",
        color: "#1f2328",
      },
    },
    h(
      "div",
      { style: { display: "flex", justifyContent: "space-between", gap: 56 } },
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", flex: 1 } },
        h(
          "div",
          {
            style: {
              display: "flex",
              flexWrap: "wrap",
              fontSize: 80,
              lineHeight: 1.15,
              letterSpacing: -1.5,
            },
          },
          h("span", { style: { fontWeight: 400 } }, `${repo.owner}/`),
          h("span", { style: { fontWeight: 700 } }, repo.name),
        ),
        h(
          "div",
          {
            style: {
              marginTop: 28,
              fontSize: 32,
              lineHeight: 1.35,
              color: "#636c76",
            },
          },
          repo.description,
        ),
      ),
      h("img", {
        src: LOGO,
        width: 200,
        height: 200,
        style: { borderRadius: 24 },
      }),
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: 80,
          bottom: 62,
          display: "flex",
        },
      },
      ...stats.map(([iconSrc, count, label]) =>
        repoStat(iconSrc, count, label),
      ),
    ),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 24,
          display: "flex",
        },
      },
      ...repo.languages.map((language) =>
        h("div", {
          style: {
            flexGrow: language.percent,
            backgroundColor: language.color,
          },
        }),
      ),
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
await writeCard(OPENSCRIBE_CARD_PATH, repoCard(OPENSCRIBE_REPO));

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
  if (
    pathname.startsWith("/og/") &&
    pathname !== HOME_CARD_PATH &&
    pathname !== OPENSCRIBE_CARD_PATH
  ) {
    cards.set(pathname, title);
  }
}

for (const [pathname, title] of cards) {
  await writeCard(pathname, titleCard(title));
}

console.log(
  `Generated the home card, the OpenScribe card and ${cards.size} title cards`,
);
