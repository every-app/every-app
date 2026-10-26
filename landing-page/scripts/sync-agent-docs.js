#!/usr/bin/env node
/**
 * Prepare the agent docs (content/agent) for the site. Runs before every
 * dev, build and type check (package.json); nothing it writes is committed.
 *
 * 1. Mirror the repository's reference documents into content/agent/repo/,
 *    so the site serves them (/docs/agent/repo/…, llms.txt, llms-full.txt)
 *    without a second copy to keep in step: docs/ stays the only place they
 *    are edited. Each document gets frontmatter (its H1 as the title, a
 *    description from the table below), relative links between repository
 *    documents become site links where the target is mirrored and GitHub
 *    links otherwise, and a `<` that would read as an HTML tag outside code
 *    is escaped, since the pages render as plain Markdown.
 *
 * 2. Write every agent page as the Markdown the site serves for it, into
 *    public/docs/agent/<page>.md (and public/docs/agent.md for the home
 *    page): its title and URL as a heading, then the page with an id on
 *    every heading (`## Exit codes [#exit-codes]`), the form fumadocs'
 *    remark-heading and remark-llms give the user docs. They ship as static
 *    assets, so an agent's fetch of /docs/agent/<page>.md never runs the
 *    Worker, and the Worker reads them through its ASSETS binding for the
 *    HTML pages, llms.txt and llms-full.txt (src/lib/agent-docs.ts) instead
 *    of bundling the pages: compiled to MDX, 3 MB of Markdown became 17 MB
 *    of JavaScript in the Worker.
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
 * page opens with (the source stays as its authors wrote it). Not here:
 * docs/threat-model-invariants.md, the register behind the threat model
 * (350 KB of tables that would swamp llms-full.txt); links to it from the
 * threat model become GitHub links.
 */
const DOCUMENTS = [
  {
    from: "docs/security-model.md",
    to: "security-model",
    description:
      "The platform's security rules: trust zones, deployment modes, what the perimeter enforces, what apps receive, hosted sign-up, MCP, secrets handling.",
  },
  {
    from: "docs/threat-model.md",
    to: "threat-model",
    metaDescription:
      "EveryApp's threat model: assets, actors, trust boundaries, one tested invariant per boundary, what Cloudflare Access adds, what is out of scope, known gaps.",
    description:
      "The threat model: assets, actors, trust boundaries, one testable invariant per boundary with the code that enforces it and the test that pins it, what Cloudflare Access adds, what is out of scope, known gaps.",
  },
  {
    from: "docs/capabilities.md",
    to: "capabilities",
    description:
      "Every capability the Gateway holds for apps (API-key providers, OAuth clients, email, members) with its settings, manifest entry, SDK call and operator setup.",
  },
  {
    from: "docs/TESTING.md",
    to: "testing",
    metaTitle: "Testing and verification",
    description:
      "How to run the repository's test suites, test locally with everyapp dev, and verify or roll back a production deploy.",
  },
  {
    from: "docs/hosted-vision.md",
    to: "hosted-vision",
    metaDescription:
      "The hosted EveryApp tier after the self-host launch: its end state, the rulings that stand, and the invariants every self-host change keeps.",
    description:
      "The hosted tier, which comes after the self-host-only launch: its end state, the rulings that stand (self-hosting keeps working from the same code), and the invariants every self-host change keeps.",
  },
  {
    from: "docs/runbooks/cloudflare-access.md",
    note: "`pnpm everyapp access on|off|show` sets the outer-ring settings this runbook describes for you ([/docs/agent/access](/docs/agent/access)).",
    to: "runbooks/cloudflare-access",
    description:
      "Operator runbook: Cloudflare Access as the sign-in (OIDC) or as an outer ring in front of the Gateway and its apps; every setting, the bypassed paths, recovery.",
  },
  {
    from: "docs/runbooks/mcp-oauth.md",
    to: "runbooks/mcp-oauth",
    description:
      "Operator runbook: the Gateway's MCP connector and OAuth server, client registration (CIMD and DCR), personal access tokens, switches, limits and audit.",
  },
  {
    from: "docs/runbooks/email-sending-setup.md",
    to: "runbooks/email-sending-setup",
    description:
      "Operator runbook: set up the Gateway's outbound email with Cloudflare Email Sending or Resend, and the settings to set.",
  },
  {
    from: "docs/runbooks/key-rotation.md",
    to: "runbooks/key-rotation",
    description:
      "Operator runbook: rotate the Gateway's identity signing key pair in a maintenance window; apps answer 401 until they are redeployed with the new public key.",
  },
  {
    from: "docs/runbooks/browser-app-install.md",
    to: "runbooks/browser-app-install",
    description:
      "Operator runbook: let the Gateway install saved app releases from the browser (the deploy token setup asks for during setup).",
  },
  {
    from: "docs/runbooks/hosted-install.md",
    note: "Written for the 2026-10-16 hosted build. The hosted tier is not open to third-party deploys at launch, and the CLI surface this runbook drives was removed on 2026-10-24 (its first paragraph says what).",
    to: "runbooks/hosted-install",
    metaDescription:
      "Operator runbook for the hosted Gateway (post-launch): install, shared first-party apps, the gated third-party deploy API, deploy keys and launch checks.",
    description:
      "Operator runbook (hosted tier, post-launch): the hosted Gateway (app.everyapp.com): install, shared first-party apps, the gated third-party deploy API and its deploy keys, launch checks.",
  },
  {
    from: "adr/ADR-0001-hosted-vs-self-hosted-topology.md",
    note: "Historical (2026-03-02). Section 6's single-tenant hosted Workers were overruled on 2026-10-16: first-party apps share one Worker per app, third-party apps get one Worker per organization on Workers for Platforms (/docs/agent/repo/security-model and /docs/agent/repo/hosted-vision).",
    to: "adr/0001-hosted-vs-self-hosted-topology",
    description:
      "Architecture decision: one codebase for the hosted and the self-hosted Gateway, and how the two differ.",
  },
  {
    from: "adr/ADR-0003-self-host-authority.md",
    to: "adr/0003-self-host-authority",
    metaTitle: "ADR-0003: Self-host operator authority",
    description:
      "Architecture decision: on a self-hosted Gateway, operator authority is Cloudflare account access; there is no deploy API.",
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

const pages = (prefix) =>
  present
    .filter((d) => d.to.startsWith(prefix))
    .map((d) => d.to.slice(prefix.length));
writeFileSync(
  join(outDir, "meta.json"),
  `${JSON.stringify(
    {
      title: "From the repository",
      description:
        "Reference documents mirrored from the repository's docs/ and adr/ directories.",
      pages: [
        ...pages("").filter((p) => !p.includes("/")),
        "---Runbooks---",
        ...pages("runbooks/").map((p) => `runbooks/${p}`),
        "---Decisions---",
        ...pages("adr/").map((p) => `adr/${p}`),
      ],
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
  // `/docs/agent.md` is the home page too, like `/docs/agent/index.md`.
  if (path === "index.md")
    writeFileSync(join(here, "..", "public", "docs", "agent.md"), served);
}
writeFileSync(pagesFile, `${JSON.stringify({ files }, null, 2)}\n`);
console.log(
  `Wrote ${files.filter((f) => f.type === "page").length} agent pages as Markdown into ${relative(process.cwd(), publicDir)}`,
);
