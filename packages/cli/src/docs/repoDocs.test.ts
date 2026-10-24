/**
 * The documents a reader or an agent reaches from the checkout, against the
 * repository and the CLI they describe: every repository path a document
 * cites exists, every `everyapp <command>` it cites is a route the CLI
 * answers, every flag it gives a command is one the command has, every
 * manifest field it names is in the schema, and every site link in the user
 * docs is a page. agentDocs.test.ts holds the agent docs to the code the
 * other way round (every identifier the code defines is documented); this
 * file catches what stays behind after a rename or a deletion, in the
 * hand-written pages around them: the README, docs/ and the runbooks, the
 * user docs, the skill and its setup files, the starter and the package
 * READMEs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandPaths } from "@/app";
import { commandDocs } from "./cliReference";
import { manifestFields } from "./manifestFields";
import { AGENT_DOCS_DIR, mirroredDocuments } from "./pages";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const at = (path: string) => posix.join(ROOT, path);

function filesIn(dir: string, ext: RegExp): string[] {
  if (!existsSync(at(dir))) return [];
  return readdirSync(at(dir))
    .filter((name) => ext.test(name))
    .sort()
    .map((name) => posix.join(dir, name));
}

/**
 * Documents that record a date's decisions and name what was deleted or
 * renamed on purpose: not checked, like TODO.md and docs/design/*.
 */
const DATED = new Set(["docs/simplify-2026-10-24.md", "docs/launch-2026-10-27.md"]);

/**
 * The documents checked, repository-relative. Not here: TODO.md, docs/design/*
 * and the DATED records above, the generated cli.md (agentDocs.test.ts
 * compares it to the commands) and the repo/ pages the site builds from docs/.
 */
const DOCUMENTS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "SECURITY.md",
  ...filesIn("docs", /\.md$/).filter((path) => !DATED.has(path)),
  ...filesIn("docs/runbooks", /\.md$/),
  ...filesIn("adr", /\.md$/),
  ...filesIn("landing-page/content/docs", /\.mdx$/),
  "landing-page/content/docs/setup-prompt.txt",
  ...filesIn("landing-page/content/agent", /\.md$/).filter((path) => !path.endsWith("/cli.md")),
  ...filesIn("packages/cli/skills/everyapp", /\.md$/),
  ...filesIn("packages/cli/skills/everyapp/setup", /\.md$/),
  "starter/README.md",
  "starter/AGENTS.md",
  "apps/every-app-gateway/README.md",
  "packages/cli/README.md",
  "packages/sdk/README.md",
  "packages/onboarding-loop/README.md",
  ".github/RELEASE.md",
].filter((path) => existsSync(at(path)));

/** The repository's top-level directories a cited path may start with, and its top-level files. */
const TOP_DIRS = new Set(["apps", "packages", "docs", "landing-page", "starter", "adr", ".github"]);
const TOP_FILES = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "SECURITY.md",
  "LICENSE",
  "TODO.md",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
]);

/**
 * Paths a document writes as an example of what someone would make, not of
 * what the repository holds.
 */
const EXAMPLE_PATHS = new Set(["apps/my-app", "apps/hello", "apps/todo", "apps/crm", "apps/<id>"]);

/**
 * A line that says a thing was deleted, removed or moved, or pins a commit
 * (`5ef30882`), may name what the repository no longer has.
 */
const HISTORICAL = /\b(deleted|removed|moved|renamed|no longer|not built|went|was|were)\b|\b[0-9a-f]{8}\b/;

/** Each line of `file` with its number, `inCode` for lines inside a fenced block. */
function lines(file: string): Array<{ n: number; text: string; inCode: boolean }> {
  const out: Array<{ n: number; text: string; inCode: boolean }> = [];
  let inCode = false;
  readFileSync(at(file), "utf8")
    .split("\n")
    .forEach((text, i) => {
      if (/^\s*(```|~~~)/.test(text)) {
        inCode = !inCode;
        return;
      }
      out.push({ n: i + 1, text, inCode });
    });
  return out;
}

/** The backticked spans of a prose line, or the whitespace-separated tokens of a code line. */
function spans(line: { text: string; inCode: boolean }): string[] {
  if (line.inCode) return line.text.split(/[\s"'`()[\],;]+/).filter(Boolean);
  return [...line.text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

/** `span` as a repository path, or null when it isn't one. */
function asRepoPath(span: string): string | null {
  let text = span.trim();
  if (text.startsWith("./")) text = text.slice(2);
  // Line numbers (`:14`, `:41-92`, `:14,41-92`), an anchor, trailing punctuation.
  text = text.replace(/#.*$/, "").replace(/:\d+(?:[-,]\d+)*$/, "").replace(/[.,;:)]+$/, "");
  if (!text || /[\s<>*{}…$|=\\]/.test(text) || text.startsWith("-")) return null;
  // Local files git ignores.
  if (/(^|\/)(\.dev\.vars|\.env)(\.|$)/.test(text)) return null;
  if (TOP_FILES.has(text)) return text;
  const [head, ...rest] = text.split("/");
  if (!head || !TOP_DIRS.has(head) || rest.length === 0) return null;
  // `docs/` alone, or a directory with its trailing slash.
  return text.replace(/\/$/, "");
}

/** A relative link target of a .md document, resolved to a repository path, or null. */
function linkedPath(file: string, target: string): string | null {
  if (/^(https?:|mailto:|#|\/)/.test(target)) return null;
  const path = target.replace(/#.*$/, "").replace(/\?.*$/, "");
  if (!path) return null;
  const resolved = posix.normalize(posix.join(dirname(file), path));
  return asRepoPath(resolved);
}

/** `text` without its backticked spans (a link inside one isn't a link). */
const withoutCode = (text: string) => text.replace(/`[^`\n]*`/g, "");

describe("the documents cite", () => {
  it("only repository paths that exist", () => {
    const missing: string[] = [];
    for (const file of DOCUMENTS) {
      const seen = new Set<string>();
      const report = (path: string, n: number) => {
        if (seen.has(path)) return;
        seen.add(path);
        if (EXAMPLE_PATHS.has(path) || existsSync(at(path))) return;
        missing.push(`${file}:${n} ${path}`);
      };
      for (const line of lines(file)) {
        if (HISTORICAL.test(line.text)) continue;
        for (const span of spans(line)) {
          const path = asRepoPath(span);
          if (path) report(path, line.n);
        }
        if (!line.inCode && file.endsWith(".md")) {
          for (const match of withoutCode(line.text).matchAll(/\]\(([^)\s]+)\)/g)) {
            const path = linkedPath(file, match[1]!);
            if (path) report(path, line.n);
          }
        }
      }
    }
    expect(
      missing,
      "paths cited in the documents that the repository doesn't have (fix the citation, or delete the paragraph)",
    ).toEqual([]);
  });
});

/** The global flags every command takes. */
const GLOBAL_FLAGS = new Set(["json", "verbose", "no-color", "help", "version"]);

/** Words a document uses as a stand-in for a command that doesn't exist. */
const PLACEHOLDER_WORDS = new Set(["foo", "bar", "baz"]);

/**
 * A quoted message or sentence that starts with "everyapp" (`everyapp is
 * running as root`, `everyapp hit a rate limit`) isn't a command: the word
 * after everyapp is one of these.
 */
const SENTENCE_WORDS = new Set(
  "is isn't has hasn't had was were will would can can't cannot could does doesn't did needs runs ran saves manages hit hits and or that itself skill command commands process exits exited prints printed writes wrote reads keeps kept makes made uses used sets starts started stops stopped gets got puts finds found asks asked refuses refused registered registers installs installed deploys deployed builds built checks checked waits waited tries tried then also only never always just still now already again too".split(
    " ",
  ),
);

/**
 * `everyapp <words…>` where a document writes a command: at the start of a
 * backticked span (after an optional `$` and `pnpm`), or anywhere as `pnpm
 * everyapp`. The words after `everyapp` up to the first argument, and the
 * flags after them. A quoted message that happens to start with "everyapp"
 * (`everyapp is running as root`) reads as a sentence and is skipped.
 */
function citedCommands(text: string, { span }: { span: boolean }): Array<{ words: string[]; flags: string[] }> {
  const out: Array<{ words: string[]; flags: string[] }> = [];
  const pattern = span
    ? /(?:^\s*(?:\$\s*)?(?:pnpm\s+)?|pnpm\s+)everyapp((?:\s+[^\s`]+)*)/g
    : /(?:^\s*(?:\$\s*)?|pnpm\s+)everyapp((?:\s+[^\s`]+)*)/g;
  for (const match of text.matchAll(pattern)) {
    const rest = match[1]!;
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const words: string[] = [];
    const flags: string[] = [];
    let arguments_ = false;
    for (const token of tokens) {
      const bare = token.replace(/^\[|\]$/g, "");
      if (/^--[a-z][a-z-]*/.test(bare)) {
        const flag = bare.replace(/^--/, "").replace(/=.*$/, "");
        if (/^[a-z][a-z-]*$/.test(flag)) flags.push(flag);
        arguments_ = true;
        continue;
      }
      if (!arguments_ && /^[a-z][a-z-]*$/.test(bare)) {
        words.push(bare);
        continue;
      }
      arguments_ = true;
    }
    if (words.length === 0 || SENTENCE_WORDS.has(words[0]!)) continue;
    out.push({ words, flags });
  }
  return out;
}

describe("the commands the documents cite", () => {
  const routes = new Set(commandPaths());
  const groups = new Set(
    [...routes].filter((route) => [...routes].some((other) => other.startsWith(`${route} `))),
  );
  const flagsByRoute = new Map(
    commandDocs().map((doc) => [doc.path, new Set(doc.flags.map((flag) => flag.name))]),
  );

  /** The route `words` name, as far as it goes. */
  const routeOf = (words: string[]): { route: string | null; unknown: string | null } => {
    const [first, second] = words;
    if (!first || PLACEHOLDER_WORDS.has(first)) return { route: null, unknown: null };
    if (!routes.has(first)) return { route: null, unknown: first };
    if (!groups.has(first)) return { route: first, unknown: null };
    if (!second || PLACEHOLDER_WORDS.has(second)) return { route: first, unknown: null };
    const full = `${first} ${second}`;
    return routes.has(full) ? { route: full, unknown: null } : { route: null, unknown: full };
  };

  it("are routes the CLI answers", () => {
    const unknown: string[] = [];
    for (const file of DOCUMENTS) {
      const seen = new Set<string>();
      for (const line of lines(file)) {
        if (HISTORICAL.test(line.text)) continue;
        const texts = line.inCode ? [line.text] : [...line.text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
        for (const text of texts) {
          for (const { words } of citedCommands(text, { span: !line.inCode })) {
            const { unknown: bad } = routeOf(words);
            if (bad && !seen.has(bad)) {
              seen.add(bad);
              unknown.push(`${file}:${line.n} everyapp ${bad}`);
            }
          }
        }
      }
    }
    expect(unknown, "commands cited in the documents that the CLI doesn't have").toEqual([]);
  });

  it("take the flags the documents give them", () => {
    const unknown: string[] = [];
    for (const file of DOCUMENTS) {
      const seen = new Set<string>();
      for (const line of lines(file)) {
        if (HISTORICAL.test(line.text)) continue;
        const texts = line.inCode ? [line.text] : [...line.text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
        for (const text of texts) {
          for (const { words, flags } of citedCommands(text, { span: !line.inCode })) {
            const { route } = routeOf(words);
            if (!route || groups.has(route)) continue;
            const known = flagsByRoute.get(route);
            if (!known) continue;
            for (const flag of flags) {
              if (GLOBAL_FLAGS.has(flag) || known.has(flag)) continue;
              const key = `${route} --${flag}`;
              if (seen.has(key)) continue;
              seen.add(key);
              unknown.push(`${file}:${line.n} everyapp ${key}`);
            }
          }
        }
      }
    }
    expect(unknown, "flags the documents give a command that the command doesn't take").toEqual([]);
  });
});

/**
 * The pages whose subject is everyapp.config.ts: a dotted name on them
 * (`resources.d1`, `secrets[].anyOf`) is a manifest field. Elsewhere the
 * same shapes are event names (`mcp.tool_call`) and file names.
 */
const MANIFEST_PAGES = [
  "landing-page/content/agent/manifest.md",
  "docs/manifest-settings.md",
  "packages/cli/skills/everyapp/SKILL.md",
  "landing-page/content/docs/create-an-app.mdx",
  "starter/README.md",
  "starter/AGENTS.md",
].filter((path) => DOCUMENTS.includes(path));

describe("the manifest fields the documents name", () => {
  const fields = manifestFields();
  const known = new Set(fields.paths);
  const heads = new Set(fields.paths.map((path) => path.split(/[.[]/)[0]!));

  /** A dotted field as the schema walks it: `capabilities.email.access` → `capabilities.<id>.access`, `[0]` and `.<n>` → `[]`. */
  const normalize = (text: string): string => {
    const parts = text.replace(/\[\d*\]/g, "[]").replace(/\.<n>/g, "[]").split(".");
    if (parts[0] === "capabilities" && parts.length > 1 && !parts[1]!.startsWith("<")) parts[1] = "<id>";
    return parts.join(".");
  };

  it("are read from the schema (an empty walk would know no field and pass)", () => {
    expect(fields.paths).toEqual(expect.arrayContaining(["id", "capabilities.<id>.access", "migrations.engine", "secrets[].anyOf"]));
    expect(fields.paths.length).toBeGreaterThanOrEqual(70);
  });

  it("are fields of everyapp.config.ts", () => {
    const unknown: string[] = [];
    for (const file of MANIFEST_PAGES) {
      const seen = new Set<string>();
      for (const line of lines(file)) {
        if (line.inCode || HISTORICAL.test(line.text)) continue;
        for (const span of spans(line)) {
          const text = span.trim();
          if (!/^[a-zA-Z]+(\[\d*\])?(\.[a-zA-Z<>]+(\[\d*\])?)+$/.test(text)) continue;
          const head = text.split(/[.[]/)[0]!;
          if (!heads.has(head)) continue;
          const path = normalize(text);
          const bare = path.replace(/\[\]$/, "");
          const ok =
            known.has(path) ||
            known.has(bare) ||
            [...known].some((field) => field.startsWith(`${path}.`) || field.startsWith(`${path}[`));
          if (ok || seen.has(text)) continue;
          seen.add(text);
          unknown.push(`${file}:${line.n} ${text}`);
        }
      }
    }
    expect(unknown, "manifest fields named on the manifest pages that everyapp.config.ts doesn't have").toEqual([]);
  });
});

describe("the user docs link", () => {
  it("only to pages that exist", () => {
    const userDocs = at("landing-page/content/docs");
    const agentDocs = fileURLToPath(AGENT_DOCS_DIR);
    const mirrored = mirroredDocuments();
    const broken: string[] = [];
    for (const file of DOCUMENTS.filter((path) => path.startsWith("landing-page/content/docs/"))) {
      for (const line of lines(file)) {
        for (const match of line.text.matchAll(/\]\((\/docs(?:\/agent)?(?:\/[a-z0-9-]+)*)(?:\.md)?(#[^)]*)?\)/g)) {
          const target = match[1]!;
          const isAgent = target.startsWith("/docs/agent");
          const rest = target.replace(/^\/docs\/agent\/?/, "").replace(/^\/docs\/?/, "");
          if (rest.startsWith("repo/")) {
            const source = mirrored.get(rest.slice("repo/".length));
            if (!source || !existsSync(at(source))) broken.push(`${file}:${line.n} → ${target}`);
            continue;
          }
          const dir = isAgent ? agentDocs : userDocs;
          const page = rest === "" ? "index" : rest;
          const exists = [".md", ".mdx"].some((ext) => existsSync(posix.join(dir, `${page}${ext}`)));
          if (!exists) broken.push(`${file}:${line.n} → ${target}`);
        }
      }
    }
    expect(broken, "links in the user docs to pages that don't exist").toEqual([]);
  });
});

describe("the documents this file checks", () => {
  it("are files", () => {
    for (const file of DOCUMENTS) expect(statSync(at(file)).isFile(), file).toBe(true);
  });
});
