const DEFAULT_SITE_URL = "https://everyapp.com";

// The image a shared link shows when the page has no title card. Both are
// drawn by scripts/generate-social-cards.js after the build.
const OG_IMAGE_PATH = "/og/home.png";
// What the home card says, so a screen reader hears the same words a sighted reader sees.
const OG_IMAGE_ALT = "EveryApp. Make every app open source.";

export const SITE_URL = (
  process.env.SITE_URL ??
  process.env.VITE_SITE_URL ??
  DEFAULT_SITE_URL
).replace(/\/+$/, "");

export function toCanonicalPath(path: string): string {
  if (!path || path === "/") return "/";

  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.replace(/\/+$/, "");
}

export function toCanonicalUrl(path: string): string {
  return new URL(toCanonicalPath(path), `${SITE_URL}/`).href;
}

// Pages whose share preview shows the page title on an EveryApp card instead
// of the home card. An entry ending in "/" covers every page below it, but not
// the index page itself. The card generator renders a card for each
// prerendered page that points at one.
const TITLE_CARD_PATHS = ["/docs", "/docs/"];

function hasTitleCard(canonicalPath: string): boolean {
  return TITLE_CARD_PATHS.some((entry) =>
    entry.endsWith("/")
      ? canonicalPath.startsWith(entry)
      : canonicalPath === entry,
  );
}

type BuildSeoParams = {
  title: string;
  path: string;
  description?: string;
  titleSuffix?: string;
  ogType?: "website" | "article";
  noindex?: boolean;
};

export function buildPageSeo({
  title,
  path,
  description,
  titleSuffix,
  ogType = "website",
  noindex = false,
}: BuildSeoParams) {
  const fullTitle = titleSuffix ? `${title} | ${titleSuffix}` : title;
  const canonicalPath = toCanonicalPath(path);
  const canonicalUrl = toCanonicalUrl(canonicalPath);
  const titleCard = hasTitleCard(canonicalPath);
  // Scrapers ignore a relative image URL.
  const imageUrl = toCanonicalUrl(
    titleCard ? `/og${canonicalPath}.png` : OG_IMAGE_PATH,
  );
  // The card generator reads a title card's title from this alt text.
  const imageAlt = titleCard ? title : OG_IMAGE_ALT;

  return {
    meta: [
      { title: fullTitle },
      ...(description ? [{ name: "description", content: description }] : []),
      { property: "og:site_name", content: "EveryApp" },
      { property: "og:type", content: ogType },
      { property: "og:title", content: fullTitle },
      ...(description
        ? [{ property: "og:description", content: description }]
        : []),
      { property: "og:url", content: canonicalUrl },
      { property: "og:image", content: imageUrl },
      { property: "og:image:alt", content: imageAlt },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: fullTitle },
      ...(description
        ? [{ name: "twitter:description", content: description }]
        : []),
      { name: "twitter:image", content: imageUrl },
      { name: "twitter:image:alt", content: imageAlt },
      ...(noindex ? [{ name: "robots", content: "noindex" }] : []),
    ],
    links: [{ rel: "canonical", href: canonicalUrl }],
  };
}
