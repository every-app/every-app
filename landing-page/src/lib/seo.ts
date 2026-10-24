const DEFAULT_SITE_URL = "https://everyapp.com";

/** The image a shared link shows, as an absolute URL (scrapers ignore a relative one). */
export const OG_IMAGE_PATH = "/OpenGraphPreview.png";

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
  const fullTitle = titleSuffix ? `${title} - ${titleSuffix}` : title;
  const canonicalUrl = toCanonicalUrl(path);

  return {
    meta: [
      { title: fullTitle },
      ...(description ? [{ name: "description", content: description }] : []),
      { property: "og:type", content: ogType },
      { property: "og:title", content: fullTitle },
      ...(description
        ? [{ property: "og:description", content: description }]
        : []),
      { property: "og:url", content: canonicalUrl },
      { property: "og:image", content: toCanonicalUrl(OG_IMAGE_PATH) },
      { property: "og:image:alt", content: fullTitle },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: fullTitle },
      ...(description
        ? [{ name: "twitter:description", content: description }]
        : []),
      { name: "twitter:image", content: toCanonicalUrl(OG_IMAGE_PATH) },
      ...(noindex ? [{ name: "robots", content: "noindex" }] : []),
    ],
    links: [{ rel: "canonical", href: canonicalUrl }],
  };
}
