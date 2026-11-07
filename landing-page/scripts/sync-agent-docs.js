#!/usr/bin/env node
/**
 * Prepare the agent docs (content/agent) for the site. Runs before every
 * dev, build and type check (package.json); nothing it writes is committed.
 *
 * 1. Mirror the security page into content/agent/repo/, so the site
 *    serves it (/docs/agent/repo/…, llms.txt) without a second copy to
 *    keep in step: docs/ stays the only place it is edited. Each document
 *    gets frontmatter (its H1 as the title, a description from the table
 *    below), relative links between repository documents become site links
 *    where the target is mirrored and GitHub links otherwise, and a `<` that
 *    would read as an HTML tag outside code is escaped, since the pages
 *    render as plain Markdown.
 *
 * 2. Write every agent page as the Markdown the site serves for it, into
 *    public/docs/agent/<page>.md (and public/docs/agent.md for the home
 *    page): its title and URL as a heading, then the page with an id on
 *    every heading (`## Exit codes [#exit-codes]`), the form fumadocs'
 *    remark-heading and remark-llms give the user docs. They ship as static
 *    assets, so an agent's fetch of /docs/agent/<page>.md never runs the
 *    Worker, and the Worker reads them through its ASSETS binding for the
 *    HTML pages, llms.txt and llms-full.txt (src/lib/agent-docs.ts) instead
 *    of bundling the pages as MDX.
 *
 * 3. Write src/lib/agent-pages.generated.json: every page's path, title
 *    and description, and the meta.json files, which is all the Worker
 *    needs for the sidebar, the page tree and llms.txt.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Slugger from "github-slugger";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const contentDir = join(here, "..", "content", "agent");
const outDir = join(contentDir, "repo");
const publicDir = join(here, "..", "public", "docs", "agent");
const pagesFile = join(here, "..", "src", "lib", "agent-pages.generated.json");
const GITHUB = "https://github.com/every-app/every-app/blob/main";
/** Where the docs are served from, for the heading each served page opens with (src/lib/source.ts has the same). */
const SITE_URL = "https://everyapp.com";

/**
 * Repository path → page under /docs/agent/repo, its one-line description
 * for llms.txt, a metaTitle or metaDescription where search results need a
 * shorter one, and for a document the code has moved past, a `note` the
 * page opens with (the source stays as its authors wrote it). Only the
 * security page is mirrored, under the `threat-model` slug that older
 * skills link to; links to any other repository document become GitHub
 * links.
 */
const DOCUMENTS = [
  {
    from: "docs/security.md",
    to: "threat-model",
    metaDescription:
      "Every App's security page: who is trusted with what, the boundaries and the test that pins each invariant, what Cloudflare Access adds, the known gaps.",
    description:
      "Security: the one rule (a person's credential stops at the Gateway), who is trusted with what, each boundary's invariants and the test that pins each, what Cloudflare Access adds, what is out of scope, the top known gaps, how to report a problem.",
  },
];

/** `<` opening what reads as a tag becomes text; an autolink `<https://…>` stays a link. */
const escapeProse = (text) =>
  text.replace(/<(?!https?:\/\/)(?=[A-Za-z/?])/g, "\\<");

function escapeTags(markdown) {
  const out = [];
  let fence = null;
  // The backtick run of a code span that continues from the previous line.
  let openSpan = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1].startsWith(fence[0]) &&
        fenceMatch[1].length >= fence.length
      )
        fence = null;
      out.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }
    // Outside code spans, a `<` that opens what reads as a tag becomes text
    // (HTML comments stay comments). A code span may run on from the previous
    // line, or open on this one and close on the next.
    let rest = line;
    let head = "";
    if (openSpan) {
      const close = rest.indexOf(openSpan);
      if (close === -1) {
        out.push(line);
        continue;
      }
      head = rest.slice(0, close + openSpan.length);
      rest = rest.slice(close + openSpan.length);
      openSpan = null;
    }
    const parts = rest.split(/(`+[^`]*?`+)/);
    const tail = parts.pop() ?? "";
    const mapped = parts.map((part, index) =>
      index % 2 === 1 ? part : escapeProse(part),
    );
    const opens = tail.match(/`+/);
    if (opens) {
      openSpan = opens[0];
      mapped.push(
        escapeProse(tail.slice(0, opens.index)) + tail.slice(opens.index),
      );
    } else {
      mapped.push(escapeProse(tail));
    }
    out.push(head + mapped.join(""));
  }
  return out.join("\n");
}

function rewriteLinks(markdown, fromPath) {
  const fromDir = posix.dirname(fromPath);
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^(https?:|mailto:|#|\/)/.test(target)) return whole;
    const [path, anchor] = target.split("#");
    const resolved = posix.normalize(posix.join(fromDir, path));
    const mirrored = bySource.get(resolved);
    const url = mirrored
      ? `/docs/agent/repo/${mirrored.to}`
      : `${GITHUB}/${resolved}`;
    return `](${url}${anchor ? `#${anchor}` : ""})`;
  });
}

rmSync(outDir, { recursive: true, force: true });
// A document the repository no longer has is skipped with a note, so a
// deletion in docs/ never breaks the landing page's build; take it out of
// DOCUMENTS when that happens.
const present = DOCUMENTS.filter((doc) => {
  if (existsSync(join(repoRoot, doc.from))) return true;
  console.warn(
    `sync-agent-docs: ${doc.from} isn't in the repository; not mirrored`,
  );
  return false;
});
const bySource = new Map(present.map((doc) => [doc.from, doc]));
for (const doc of present) {
  const raw = readFileSync(join(repoRoot, doc.from), "utf8");
  const lines = raw.split("\n");
  const titleIndex = lines.findIndex((line) => /^# /.test(line));
  const title =
    titleIndex >= 0 ? lines[titleIndex].replace(/^# /, "").trim() : doc.to;
  const body = (
    titleIndex >= 0 ? lines.filter((_, i) => i !== titleIndex) : lines
  )
    .join("\n")
    .replace(/^\n+/, "");
  const note = `> Mirrored from [\`${doc.from}\`](${GITHUB}/${doc.from}) in the EveryApp repository, where it is edited.${doc.note ? `\n>\n> **Read with care:** ${doc.note}` : ""}\n\n`;
  const meta = ["metaTitle", "metaDescription"]
    .filter((field) => doc[field])
    .map((field) => `${field}: ${JSON.stringify(doc[field])}\n`)
    .join("");
  const content = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(doc.description)}\n${meta}---\n\n${note}${escapeTags(rewriteLinks(body, doc.from))}`;
  const target = join(outDir, `${doc.to}.md`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

writeFileSync(
  join(outDir, "meta.json"),
  `${JSON.stringify(
    {
      title: "From the repository",
      description:
        "The security page, mirrored from the repository's docs/ directory.",
      pages: present.map((d) => d.to),
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Mirrored ${present.length} repository documents into ${relative(process.cwd(), outDir)}`,
);

// 2 and 3: the served Markdown of every agent page, and the pages index.

/** `title: "x"` or `title: x` from a page's frontmatter. */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("a page without frontmatter");
  const data = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^(\w+):\s*(.*)$/);
    if (!field) continue;
    const value = field[2].trim();
    data[field[1]] = /^".*"$/.test(value) ? JSON.parse(value) : value;
  }
  return { data, body: raw.slice(match[0].length) };
}

/**
 * The text of a heading the way remark sees it (mdast-util flattened): code
 * spans and emphasis without their markers, a link as its text, an escape as
 * the character.
 */
function headingText(inline) {
  return inline
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w\\])[*_](.+?)[*_](?=[^\w]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, "$1");
}

/**
 * The page with an id on every heading outside code: a `[#custom]` the
 * author wrote stays, every other heading gets `[#slug]` from its text
 * (github-slugger, numbered on a repeat, as fumadocs' remark-heading does).
 */
function withHeadingIds(body) {
  const slugger = new Slugger();
  let fence = null;
  const lines = body.split("\n").map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1].startsWith(fence[0]) &&
        fenceMatch[1].length >= fence.length
      )
        fence = null;
      return line;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return line;
    }
    const heading = line.match(/^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (!heading) return line;
    const text = heading[2].replace(/[ \t]+$/, "");
    if (/\s*\[#[^]+?\]\s*$/.test(text) || text === "") return line;
    return `${line.replace(/[ \t]+$/, "")} [#${slugger.slug(headingText(text))}]`;
  });
  return lines.join("\n");
}

function walk(dir, prefix = "") {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      files.push(...walk(path, `${prefix}${name}/`));
    else if (name.endsWith(".md") || name === "meta.json")
      files.push(`${prefix}${name}`);
  }
  return files;
}

rmSync(publicDir, { recursive: true, force: true });
rmSync(join(here, "..", "public", "docs", "agent.md"), { force: true });
const files = [];
for (const path of walk(contentDir)) {
  if (path.endsWith("meta.json")) {
    files.push({
      type: "meta",
      path,
      data: JSON.parse(readFileSync(join(contentDir, path), "utf8")),
    });
    continue;
  }
  const { data, body } = parseFrontmatter(
    readFileSync(join(contentDir, path), "utf8"),
  );
  if (!data.title) throw new Error(`${path} has no title`);
  files.push({
    type: "page",
    path,
    data: {
      title: data.title,
      description: data.description,
      metaTitle: data.metaTitle,
      metaDescription: data.metaDescription,
    },
  });
  const slugs = path.replace(/\.md$/, "").split("/");
  if (slugs.at(-1) === "index") slugs.pop();
  const url = ["/docs/agent", ...slugs].join("/");
  const markdown = `${withHeadingIds(body).trim()}\n`.replace(
    /\n{3,}/g,
    "\n\n",
  );
  const served = `# ${data.title} (${SITE_URL}${url})\n\n${markdown}`;
  const target = join(publicDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, served);
  // `/docs/agent.md` is the home page too, like `/docs/agent/index.md`, and
  // a folder's index is `<folder>.md` too (`/docs/agent/setup.md`).
  if (path === "index.md")
    writeFileSync(join(here, "..", "public", "docs", "agent.md"), served);
  else if (path.endsWith("/index.md"))
    writeFileSync(join(publicDir, path.replace(/\/index\.md$/, ".md")), served);
}
writeFileSync(pagesFile, `${JSON.stringify({ files }, null, 2)}\n`);
console.log(
  `Wrote ${files.filter((f) => f.type === "page").length} agent pages as Markdown into ${relative(process.cwd(), publicDir)}`,
);
