#!/usr/bin/env node

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST_DIR = join(__dirname, "../dist/client");
const DEFAULT_SITE_URL = "https://everyapp.dev";
const SITE_URL = (process.env.SITE_URL ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
const EXCLUDED_HTML = new Set(["404.html", "500.html"]);

function walkHtmlFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkHtmlFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function toUrlPath(htmlFilePath) {
  const relativePath = relative(DIST_DIR, htmlFilePath).split(sep).join("/");

  if (EXCLUDED_HTML.has(relativePath)) {
    return null;
  }

  if (relativePath === "index.html") {
    return "/";
  }

  if (relativePath.endsWith("/index.html")) {
    return `/${relativePath.slice(0, -"/index.html".length)}/`;
  }

  return `/${relativePath}`;
}

function main() {
  if (!existsSync(DIST_DIR) || !statSync(DIST_DIR).isDirectory()) {
    throw new Error(`Build output directory does not exist: ${DIST_DIR}`);
  }

  const urlSet = new Set();
  const htmlFiles = walkHtmlFiles(DIST_DIR);

  for (const htmlFile of htmlFiles) {
    const urlPath = toUrlPath(htmlFile);
    if (!urlPath) continue;

    const fullUrl = new URL(urlPath, `${SITE_URL}/`).href;
    urlSet.add(fullUrl);
  }

  const urls = Array.from(urlSet).sort((a, b) => a.localeCompare(b));
  const lastmod = new Date().toISOString();

  const sitemapBody = urls
    .map(
      (url) =>
        `  <url>\n    <loc>${url}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
    )
    .join("\n");

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapBody}\n</urlset>\n`;
  const sitemapPath = join(DIST_DIR, "sitemap.xml");
  writeFileSync(sitemapPath, sitemapXml);

  console.log(`Generated sitemap with ${urls.length} URLs at ${sitemapPath}`);
}

main();
