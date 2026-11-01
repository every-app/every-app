#!/usr/bin/env node
/**
 * Preflight: crawl a build of everyapp.com and fail on what a visitor or a
 * coding agent would hit. Run it against the local preview before a deploy
 * and against the live site after one (docs/runbooks/site-preflight.md):
 *
 *   pnpm -C landing-page preflight                        # http://localhost:4322
 *   pnpm -C landing-page preflight https://everyapp.com   # after `pnpm deploy`
 *   pnpm -C landing-page preflight https://everyapp.com --external
 *
 * It checks that every page in the sitemap and every page reached from "/"
 * answers 200 as HTML; that every internal link resolves without a redirect
 * and its #anchor exists on the target; that every docs page's `.md` twin
 * answers 200 as Markdown; that /llms.txt lists every page and every URL in
 * it resolves; that /llms-full.txt carries every page outside repo/ and no
 * MDX comment; that /robots.txt names the sitemap and the sitemap lists
 * every page; that /docs/internal and an unknown path answer 404; that every
 * page has a title, a description, og:title, og:url and a canonical link;
 * that no page says what the site must no longer say (a private repository,
 * an old CLI verb, the waitlist on the home page); and that every
 * github.com/every-app/every-app/blob/main/<path> link names a file this
 * checkout has. `--external` also fetches every external link (a failure is
 * a warning: other sites have bad days). No dependencies; Node 22.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const base = (
  args.find((a) => !a.startsWith("--")) ??
  process.env.SITE_URL ??
  "http://localhost:4322"
).replace(/\/+$/, "");
const checkExternal = flags.has("--external");
const CANONICAL_ORIGIN = "https://everyapp.com";

const errors = [];
const warnings = [];
const error = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

/** fetch without following redirects, with a timeout; a thrown error becomes status 0. */
async function get(url, { method = "GET", timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "everyapp-preflight/1 (+https://everyapp.com)" },
    });
    const text = method === "GET" ? await res.text() : "";
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      location: res.headers.get("location") ?? "",
      text,
    };
  } catch (e) {
    return { status: 0, type: "", location: "", text: "", error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

/** The attributes of one tag as an object (lower-cased names). */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? "");
  }
  return out;
}

/** What the page's HTML says: head tags, ids, links, and its visible text. */
function parseHtml(html) {
  const head = {};
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/);
  head.title = title ? decode(title[1]).trim() : "";
  for (const m of html.matchAll(/<meta\s[^>]*>/g)) {
    const a = attrs(m[0]);
    const key = a.property ?? a.name;
    if (key && a.content !== undefined) head[key] = a.content;
  }
  for (const m of html.matchAll(/<link\s[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.rel === "canonical") head.canonical = a.href;
  }
  const ids = new Set();
  for (const m of html.matchAll(/\s(?:id|name)="([^"]+)"/g))
    ids.add(decode(m[1]));
  const links = [];
  for (const m of html.matchAll(/<a\s[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.href) links.push(a.href);
  }
  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
  return { head, ids, links, text };
}

/** A link target split into its site path and anchor, or null for a link that isn't to this site. */
function internal(href) {
  if (!href || href.startsWith("#"))
    return href === "#" || !href ? null : { path: null, anchor: href.slice(1) };
  if (/^(mailto:|tel:|javascript:)/.test(href)) return null;
  if (/^https?:\/\//.test(href)) {
    for (const origin of [base, CANONICAL_ORIGIN]) {
      if (href.startsWith(`${origin}/`) || href === origin) {
        href = href.slice(origin.length) || "/";
        break;
      }
    }
    if (/^https?:\/\//.test(href)) return null;
  }
  const [withQuery, anchor] = href.split("#");
  const path = withQuery.split("?")[0] || "/";
  return { path, anchor: anchor ?? "" };
}

/**
 * What no public page may say. Each pattern is checked against the visible
 * text of every HTML page and the body of every Markdown twin; `only`
 * restricts a check to some paths, `unless` lets a sentence that says the
 * thing is gone through.
 */
const FORBIDDEN = [
  {
    re: /private-every[-]app/i, // spelt so the public-copy check does not read it as the name
    why: "names the private repository",
    severity: "error",
  },
  {
    re: /TODO\(publishing\)/,
    why: "an MDX comment reached the page",
    severity: "error",
  },
  {
    re: /everyapp gateway deploy/i,
    why: "the old verb for `update`",
    severity: "error",
  },
  {
    re: /--bundle-only/i,
    why: "the old flag for `release`",
    severity: "error",
  },
  {
    re: /everyapp workflow\b/i,
    why: "the workflow command group is gone",
    severity: "error",
  },
  {
    re: /\bwaitlist\b/i,
    why: "the launch page has no waitlist",
    severity: "error",
    only: /^\/$/,
  },
  {
    re: /\bexamples\//,
    why: "examples/ was deleted",
    severity: "warning",
    unless: /\b(deleted|removed|went|no longer|was|were)\b/i,
  },
  {
    re: /\bmobile (app|shell)\b/i,
    why: "the mobile app is gone",
    severity: "warning",
    unless: /\b(deleted|removed|went|no longer|was|were|gone)\b/i,
  },
  {
    re: /\bpostiz\b/i,
    why: "Postiz is not part of the launch",
    severity: "warning",
    only: /^\/(docs(\/[a-z-]+)?)?$/,
  },
];

function sayings(path, text, where) {
  for (const rule of FORBIDDEN) {
    if (rule.only && !rule.only.test(path)) continue;
    const sentences = text.split(/(?<=[.!?])\s+/);
    const hits = sentences.filter(
      (s) => rule.re.test(s) && !(rule.unless && rule.unless.test(s)),
    );
    if (hits.length === 0) continue;
    const msg = `${where} says "${hits[0].trim().slice(0, 160)}" (${rule.why}${hits.length > 1 ? `, ${hits.length} sentences` : ""})`;
    (rule.severity === "error" ? error : warn)(msg);
  }
}

const pages = new Map(); // path → { status, type, parsed }
const markdownTwins = new Map(); // path → { status, type, text }
const sitemapPaths = new Set();

async function fetchPage(path) {
  if (pages.has(path)) return pages.get(path);
  const res = await get(`${base}${path}`);
  const entry = {
    status: res.status,
    type: res.type,
    location: res.location,
    parsed: null,
  };
  if (res.status === 200 && res.type.includes("text/html"))
    entry.parsed = parseHtml(res.text);
  pages.set(path, entry);
  return entry;
}

/** The `.md` twin of a docs page: /docs → /docs/index.md, /docs/agent/x → /docs/agent/x.md. */
const twinOf = (path) =>
  path === "/docs" || path === "/docs/agent"
    ? `${path}/index.md`
    : `${path}.md`;

async function main() {
  console.log(`Preflight against ${base}`);

  // 1. robots.txt and the sitemap.
  const robots = await get(`${base}/robots.txt`);
  if (robots.status !== 200) error(`/robots.txt answers ${robots.status}`);
  else if (!/^Sitemap:\s*\S+\/sitemap\.xml/m.test(robots.text))
    error("/robots.txt doesn't name /sitemap.xml");
  const sitemap = await get(`${base}/sitemap.xml`);
  if (sitemap.status !== 200) error(`/sitemap.xml answers ${sitemap.status}`);
  for (const m of sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const link = internal(m[1].trim());
    if (!link || link.path === null)
      error(`sitemap lists a URL off this site: ${m[1]}`);
    else sitemapPaths.add(link.path.replace(/\/+$/, "") || "/");
  }
  if (sitemapPaths.size === 0) error("the sitemap lists no pages");

  // 2. Crawl: the sitemap's pages, the pages nothing links to yet, and everything reachable from "/".
  const queue = [...new Set(["/", "/privacy", ...sitemapPaths])];
  const seen = new Set(queue);
  const linkChecks = []; // { from, href, path, anchor }
  while (queue.length > 0) {
    const batch = queue.splice(0, 12);
    await pool(batch, 12, async (path) => {
      const page = await fetchPage(path);
      if (page.status !== 200) {
        error(
          `${path} answers ${page.status}${page.location ? ` → ${page.location}` : ""}`,
        );
        return;
      }
      if (!page.parsed) {
        if (!/\.(md|txt|xml|json|png|ico|js|css)$/.test(path))
          warn(`${path} is ${page.type}, not HTML`);
        return;
      }
      const { head, links, text } = page.parsed;
      if (!head.title) error(`${path} has no <title>`);
      if (/undefined|\[object/.test(head.title))
        error(`${path} has a broken title: "${head.title}"`);
      if (!head.description) warn(`${path} has no meta description`);
      if (!head["og:title"]) warn(`${path} has no og:title`);
      if (!head["og:url"]) warn(`${path} has no og:url`);
      if (!head.canonical) warn(`${path} has no canonical link`);
      else {
        if (!head.canonical.startsWith(`${CANONICAL_ORIGIN}/`))
          error(
            `${path} canonical is ${head.canonical}, not under ${CANONICAL_ORIGIN}`,
          );
        const canonicalPath =
          head.canonical.slice(CANONICAL_ORIGIN.length) || "/";
        if (canonicalPath !== path)
          error(`${path} canonical names ${canonicalPath}`);
        if (head["og:url"] && head["og:url"] !== head.canonical)
          error(
            `${path} og:url (${head["og:url"]}) differs from its canonical (${head.canonical})`,
          );
      }
      if (
        /Unknown (docs|agent docs) page:|might have been removed, had its name/.test(
          text,
        )
      )
        error(`${path} renders an error or the 404 page`);
      sayings(path, text, path);
      for (const href of links) {
        const link = internal(href);
        if (!link) {
          if (/^https?:\/\//.test(href)) externalLinks.set(href, path);
          continue;
        }
        if (link.path === null) {
          linkChecks.push({ from: path, href, path, anchor: link.anchor });
          continue;
        }
        if (link.path.startsWith("/api/")) continue;
        linkChecks.push({
          from: path,
          href,
          path: link.path,
          anchor: link.anchor,
        });
        if (!seen.has(link.path) && !/\.[a-z0-9]+$/i.test(link.path)) {
          seen.add(link.path);
          queue.push(link.path);
        }
      }
    });
  }
  const htmlPages = [...pages]
    .filter(([, p]) => p.parsed)
    .map(([path]) => path);
  console.log(
    `  ${htmlPages.length} HTML pages, ${linkChecks.length} internal links`,
  );

  // 3. Every internal link resolves (200, no redirect) and its anchor exists.
  const targets = [...new Set(linkChecks.map((l) => l.path))];
  await pool(targets, 12, (path) => fetchPage(path));
  const reported = new Set();
  for (const l of linkChecks) {
    const target = pages.get(l.path);
    const key = `${l.from} → ${l.href}`;
    if (reported.has(key)) continue;
    if (target.status !== 200) {
      reported.add(key);
      error(
        `${l.from} links to ${l.href}, which answers ${target.status}${target.location ? ` → ${target.location}` : ""}`,
      );
      continue;
    }
    if (
      l.anchor &&
      target.parsed &&
      !target.parsed.ids.has(decodeURIComponent(l.anchor))
    ) {
      reported.add(key);
      error(
        `${l.from} links to ${l.href}, but ${l.path} has no id "${l.anchor}"`,
      );
    }
  }
  for (const path of htmlPages) {
    if (!sitemapPaths.has(path)) warn(`${path} is not in the sitemap`);
  }

  // 4. The `.md` twins, with their own links.
  const docsPages = htmlPages.filter(
    (p) => p === "/docs" || p.startsWith("/docs/"),
  );
  await pool(docsPages, 12, async (path) => {
    const twin = twinOf(path);
    const res = await get(`${base}${twin}`);
    markdownTwins.set(twin, res);
    if (res.status !== 200) {
      error(`${twin} answers ${res.status}`);
      return;
    }
    if (!res.type.includes("text/markdown"))
      warn(`${twin} is ${res.type}, not text/markdown`);
    if (!res.text.startsWith("# "))
      warn(`${twin} doesn't start with its title line`);
    if (/\{\/\*/.test(res.text)) error(`${twin} carries an MDX comment`);
    if (/<include\b/.test(res.text))
      error(`${twin} carries an unexpanded <include>`);
    sayings(path, res.text, twin);
    for (const m of res.text.matchAll(/\]\(((?:\/|https?:\/\/|#)[^)\s]+)\)/g)) {
      const link = internal(m[1]);
      if (!link || link.path === null || link.path.startsWith("/api/"))
        continue;
      const target = await fetchPage(link.path);
      if (target.status !== 200)
        error(`${twin} links to ${m[1]}, which answers ${target.status}`);
      else if (
        link.anchor &&
        target.parsed &&
        !target.parsed.ids.has(decodeURIComponent(link.anchor))
      )
        error(
          `${twin} links to ${m[1]}, but ${link.path} has no id "${link.anchor}"`,
        );
    }
  });
  console.log(`  ${docsPages.length} Markdown twins`);

  // 5. llms.txt and llms-full.txt.
  const llms = await get(`${base}/llms.txt`);
  if (llms.status !== 200 || !llms.type.includes("text/plain"))
    error(`/llms.txt answers ${llms.status} ${llms.type}`);
  else {
    for (const heading of ["## User guides", "## Agent docs"]) {
      if (!llms.text.includes(heading))
        error(`/llms.txt has no "${heading}" section`);
    }
    const listed = new Set();
    for (const m of llms.text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      const link = internal(m[1]);
      if (!link || link.path === null) {
        warn(`/llms.txt links off-site: ${m[1]}`);
        continue;
      }
      listed.add(link.path);
    }
    await pool([...listed], 12, async (path) => {
      const page = await fetchPage(path);
      if (page.status !== 200)
        error(`/llms.txt lists ${path}, which answers ${page.status}`);
    });
    for (const path of docsPages) {
      if (!listed.has(path)) error(`/llms.txt doesn't list ${path}`);
    }
    sayings("/llms.txt", llms.text, "/llms.txt");
  }
  const full = await get(`${base}/llms-full.txt`, { timeoutMs: 60_000 });
  if (full.status !== 200 || !full.type.includes("text/plain"))
    error(`/llms-full.txt answers ${full.status} ${full.type}`);
  else {
    if (/\{\/\*/.test(full.text))
      error("/llms-full.txt carries an MDX comment");
    if (/<include\b/.test(full.text))
      error("/llms-full.txt carries an unexpanded <include>");
    if (/^import .* from "(?:fumadocs|@\/)/m.test(full.text))
      warn("/llms-full.txt carries an MDX import line");
    for (const path of docsPages) {
      const expected = path.startsWith("/docs/agent/repo/") ? false : true;
      const present = full.text.includes(`(${CANONICAL_ORIGIN}${path})`);
      if (expected && !present) error(`/llms-full.txt doesn't carry ${path}`);
      if (!expected && present)
        warn(
          `/llms-full.txt carries the mirrored ${path}, which llms.txt says it leaves out`,
        );
    }
    sayings("/llms-full.txt", full.text, "/llms-full.txt");
    console.log(
      `  /llms-full.txt is ${(full.text.length / 1024 / 1024).toFixed(2)} MB`,
    );
  }

  // 6. 404s and the moved pages.
  for (const path of [
    "/docs/internal",
    "/docs/internal.md",
    "/docs/agent/nope",
    "/docs/agent/nope.md",
    "/nope-preflight",
  ]) {
    const res = await get(`${base}${path}`);
    if (res.status !== 404) error(`${path} answers ${res.status}, not 404`);
  }
  for (const [from, to] of [
    ["/docs/quickstart", "/docs/gateway"],
    ["/docs/introduction", "/docs"],
    ["/docs/reference/cli", "/docs/commands"],
  ]) {
    const res = await get(`${base}${from}`);
    const location = res.location.replace(/^https?:\/\/[^/]+/, "");
    if (![301, 302, 307, 308].includes(res.status) || location !== to)
      warn(
        `${from} answers ${res.status}${res.location ? ` → ${res.location}` : ""}, expected a redirect to ${to}`,
      );
  }

  // 7. GitHub links to the public repository name files this checkout has.
  for (const [href, from] of externalLinks) {
    const m = href.match(
      /^https:\/\/github\.com\/every-app\/every-app\/(?:blob|tree)\/main\/([^#?]+)/,
    );
    if (!m) continue;
    const path = decodeURIComponent(m[1]).replace(/\/+$/, "");
    if (!existsSync(join(repoRoot, path)))
      error(`${from} links to ${href}, but the checkout has no ${path}`);
  }

  // 8. External links, on request.
  if (checkExternal) {
    const hrefs = [...externalLinks.keys()].filter(
      (h) =>
        !/^https:\/\/github\.com\/every-app\/every-app\/(blob|tree)\//.test(h),
    );
    console.log(`  ${hrefs.length} external links`);
    await pool(hrefs, 6, async (href) => {
      let res = await get(href, { method: "HEAD" });
      if (res.status === 0 || res.status === 405 || res.status >= 400)
        res = await get(href);
      if (res.status === 0)
        warn(
          `${href} (from ${externalLinks.get(href)}) didn't answer: ${res.error ?? ""}`,
        );
      else if (res.status === 403 || res.status === 429 || res.status === 999)
        warn(
          `${href} (from ${externalLinks.get(href)}) answers ${res.status}: unverified`,
        );
      else if (res.status >= 400)
        warn(`${href} (from ${externalLinks.get(href)}) answers ${res.status}`);
    });
  }

  // Report.
  console.log("");
  for (const w of warnings) console.log(`  warning  ${w}`);
  for (const e of errors) console.log(`  ERROR    ${e}`);
  console.log("");
  console.log(`${errors.length} errors, ${warnings.length} warnings`);
  process.exit(errors.length > 0 ? 1 : 0);
}

const externalLinks = new Map(); // href → first page linking it
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
