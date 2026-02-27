#!/usr/bin/env node

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST_DIR = join(__dirname, "../dist/client");
const DOCS_CONTENT_DIR = join(__dirname, "../content/docs");
const BLOG_CONTENT_DIR = join(__dirname, "../content/blog");

const DEFAULT_SITE_URL = "https://everyapp.dev";
const SITE_URL = (process.env.SITE_URL ?? DEFAULT_SITE_URL).replace(/\/+$/, "");

const DOC_EXTENSIONS = new Set([".md", ".mdx"]);
const STATIC_PATHS = new Set(["/", "/docs", "/blogs"]);

function walkMarkdownFiles(directory) {
  if (!existsSync(directory)) return [];

  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && DOC_EXTENSIONS.has(extname(entry.name))) {
      files.push(absolutePath);
    }
  }

  return files;
}

function toSlugs(rootDir, filePath) {
  const relativePath = relative(rootDir, filePath).split(sep).join("/");
  const withoutExtension = relativePath.replace(/\.(md|mdx)$/i, "");
  const slugs = withoutExtension.split("/").filter(Boolean);

  if (slugs[slugs.length - 1] === "index") {
    slugs.pop();
  }

  return slugs;
}

function joinPath(basePath, slugs) {
  if (slugs.length === 0) return basePath;
  return `${basePath}/${slugs.join("/")}`;
}

function toCanonicalUrl(path) {
  if (path === "/") {
    return `${SITE_URL}/`;
  }

  return `${SITE_URL}${path.replace(/\/+$/, "")}`;
}

function addContentPaths(urlPaths, basePath, contentDir) {
  for (const filePath of walkMarkdownFiles(contentDir)) {
    const slugs = toSlugs(contentDir, filePath);
    if (slugs.length === 0) continue;
    urlPaths.add(joinPath(basePath, slugs));
  }
}

function main() {
  if (!existsSync(DIST_DIR) || !statSync(DIST_DIR).isDirectory()) {
    throw new Error(`Build output directory does not exist: ${DIST_DIR}`);
  }

  const urlPaths = new Set(STATIC_PATHS);

  addContentPaths(urlPaths, "/docs", DOCS_CONTENT_DIR);
  addContentPaths(urlPaths, "/blogs", BLOG_CONTENT_DIR);

  const urls = Array.from(urlPaths)
    .map((path) => toCanonicalUrl(path))
    .sort((a, b) => a.localeCompare(b));

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
