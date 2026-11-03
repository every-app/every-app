/**
 * The agent docs (landing-page/content/agent, served at everyapp.com/docs/agent
 * and indexed by /llms.txt) against the code. One check per kind of drift:
 *
 *  - the generated pages and blocks are what the code generates now
 *    (cli.md from the commands, errors.md's headings from the codes, the
 *    provider catalog);
 *  - every page is in the sidebar, and every link to a docs page and its
 *    anchor resolves, from the docs, the skills and the code;
 *  - the manifest page names every field of everyapp.config.ts;
 *  - the codes, settings and built-in tools the hand-written pages name
 *    are still in the code.
 *
 * repoDocs.test.ts checks that the commands, flags, paths and manifest
 * fields the documents name exist. To regenerate:
 *
 *   pnpm -C packages/cli docs:update
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { listBuiltinTools } from "@every-app/toolbus";
import { describe, expect, it, vi } from "vitest";

// The agent docs say commands as someone who installed everyapp with npm
// types them (`everyapp …`), not as this test runner invokes it
// (vitest.config.ts sets a pnpm user agent for the CLI's other tests).
vi.hoisted(() => {
  process.env["npm_config_user_agent"] = "";
});
import { cliReference } from "./cliReference";
import { codeInventory } from "./codes";
import { errorsPage } from "./errorsPage";
import { manifestFields } from "./manifestFields";
import { providersCatalog, setupProvidersPage, withBlock } from "./providersCatalog";
import {
  AGENT_DOCS_DIR,
  SKILL_PAGES,
  UPDATE_DOCS,
  anchorsOf,
  backticked,
  mirroredDocuments,
  readPage,
  writePage,
} from "./pages";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const at = (path: string) => posix.join(ROOT, path);
const STALE = "is out of date with the code: run `pnpm -C packages/cli docs:update` and commit the result";

/** The hand-written and generated agent pages (the repo/ mirror and the skill pages are written by the site build). */
const slugs = () =>
  readdirSync(fileURLToPath(AGENT_DOCS_DIR))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .filter((slug) => !SKILL_PAGES.has(slug));

function expectGenerated(slug: string, generated: string): void {
  if (UPDATE_DOCS) {
    writePage(slug, generated);
    return;
  }
  expect(readPage(slug), `${slug}.md ${STALE}`).toBe(generated);
}

/** A generated block of a hand-written page, between its `<!-- <name>:begin` and `<!-- <name>:end -->` markers. */
function expectBlock(slug: string, name: string, block: string): void {
  const page = readPage(slug);
  const updated = withBlock(page, name, block);
  expect(updated, `${slug}.md has no ${name} block`).not.toBeNull();
  if (UPDATE_DOCS) {
    if (updated !== page) writePage(slug, updated!);
    return;
  }
  expect(page, `${slug}.md's ${name} block ${STALE}`).toBe(updated);
}

describe("the generated pages", () => {
  it("cli.md is what the commands generate", () => {
    expectGenerated("cli", cliReference());
  });

  it("errors.md has a heading for every code the source defines, and none it doesn't", () => {
    expectGenerated("errors", errorsPage(readPage("errors")));
    expect(readPage("errors"), "errors.md has a code without its line").not.toContain("No description yet.");
  });

  it("providers.md has the catalog the provider catalog generates", () => {
    expectBlock("providers", "providers-catalog", providersCatalog());
  });

  it("the everyapp skill's setup/providers.md is what the provider catalog generates", () => {
    expectGenerated("../../../packages/cli/skills/everyapp/setup/providers", setupProvidersPage());
  });
});

describe("the pages", () => {
  it("are all in the sidebar (meta.json), which names only pages that exist", () => {
    const meta = JSON.parse(readFileSync(fileURLToPath(new URL("meta.json", AGENT_DOCS_DIR)), "utf8")) as {
      pages: string[];
    };
    // Separators (`---Build---`), the link back to the user docs and the mirrored `repo` folder aren't pages.
    const listed = meta.pages.filter((entry) => !/^---.*---$/.test(entry) && !entry.startsWith("[") && entry !== "repo");
    const pages = [...slugs(), ...SKILL_PAGES.keys()];
    expect(listed.filter((slug) => !pages.includes(slug)), "slugs in meta.json without a page").toEqual([]);
    expect(pages.filter((slug) => !listed.includes(slug)), "pages missing from meta.json").toEqual([]);
  });

  it("each have a title and a description, which llms.txt lists", () => {
    for (const slug of slugs()) {
      const front = readPage(slug).match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
      expect(front, `${slug}.md's frontmatter`).toMatch(/^title: .+$/m);
      expect(front, `${slug}.md's frontmatter`).toMatch(/^description: .+$/m);
    }
  });
});

/** The headings' anchors of a docs page by its path under /docs, or null when there is no such page. */
function anchorsOfPage(path: string): Set<string> | null {
  const agent = path.match(/^agent(?:\/(.*))?$/);
  if (agent) {
    const rest = agent[1] ?? "index";
    if (rest.startsWith("repo/")) {
      const source = mirroredDocuments().get(rest.slice("repo/".length));
      return source && existsSync(at(source)) ? anchorsOf(readFileSync(at(source), "utf8")) : null;
    }
    const skill = SKILL_PAGES.get(rest);
    if (skill) return anchorsOf(readFileSync(at(skill), "utf8"));
    const file = fileURLToPath(new URL(`${rest}.md`, AGENT_DOCS_DIR));
    return existsSync(file) ? anchorsOf(readFileSync(file, "utf8")) : null;
  }
  const page = path === "" ? "index" : path;
  for (const name of [`${page}.mdx`, `${page}/index.mdx`]) {
    const file = at(`landing-page/content/docs/${name}`);
    if (existsSync(file)) return anchorsOf(readFileSync(file, "utf8"));
  }
  // Generated provider pages are gitignored, written by providerPages.test.ts.
  return path.startsWith("providers/") ? new Set() : null;
}

/** Every file a link into the docs may sit in: the docs, the skills, the README files and the code. */
function linkingFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(at(dir))) return;
    for (const name of readdirSync(at(dir))) {
      const path = posix.join(dir, name);
      if (name === "node_modules" || name.startsWith(".") || name === "dist") continue;
      if (statSync(at(path)).isDirectory()) walk(path);
      else if (/\.(md|mdx|ts|tsx|txt)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".generated.ts")) files.push(path);
    }
  };
  for (const dir of [
    "landing-page/content/agent",
    "landing-page/content/docs",
    "landing-page/src",
    "packages/cli/skills",
    "packages/cli/src",
    "packages/sdk/src",
    "packages/toolbus/src",
    "packages/perimeter/src",
    "apps/every-app-gateway/src",
    "starter",
  ]) {
    walk(dir);
  }
  return [...files, "README.md", "AGENTS.md"].filter((path) => existsSync(at(path)) && !path.includes("/content/docs/providers/"));
}

describe("links into the docs", () => {
  it("reach pages and headings that exist", () => {
    const broken: string[] = [];
    const cache = new Map<string, Set<string> | null>();
    for (const file of linkingFiles()) {
      const text = readFileSync(at(file), "utf8");
      // `/docs/…` as a Markdown link target, or anywhere as an everyapp.com URL.
      const pattern = /(?:\]\(|https:\/\/everyapp\.com)\/docs((?:\/[a-z0-9-]+)*)(?:\.md)?(?:#([A-Za-z0-9_-]+))?/g;
      for (const match of text.matchAll(pattern)) {
        const path = (match[1] ?? "").replace(/^\//, "");
        if (!cache.has(path)) cache.set(path, anchorsOfPage(path));
        const anchors = cache.get(path)!;
        const where = `${file} → /docs/${path}${match[2] ? `#${match[2]}` : ""}`;
        if (!anchors) broken.push(`${where} (no such page)`);
        else if (match[2] && !anchors.has(match[2].toLowerCase())) broken.push(`${where} (no such heading)`);
      }
    }
    expect(broken, "links to docs pages or headings that don't exist").toEqual([]);
  });
});

describe("manifest.md", () => {
  it("names every field of everyapp.config.ts", () => {
    const fields = manifestFields();
    expect(fields.paths, "the schema walk found the fields").toEqual(
      expect.arrayContaining(["id", "capabilities.<id>.access", "migrations.engine", "secrets[].anyOf"]),
    );
    const found = backticked(readPage("manifest"));
    const missing = fields.paths.filter((path) => !found.has(path));
    expect(missing, "manifest fields manifest.md doesn't name in backticks").toEqual([]);
  });
});

/** The text of every source file the CLI, SDK, perimeter, toolbus, Gateway and starter are built from, joined. */
function sourceText(): string {
  const texts: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(at(dir))) return;
    for (const name of readdirSync(at(dir))) {
      const path = posix.join(dir, name);
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      if (statSync(at(path)).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) texts.push(readFileSync(at(path), "utf8"));
    }
  };
  for (const dir of [
    "packages/cli/src",
    "packages/sdk/src",
    "packages/perimeter/src",
    "packages/toolbus/src",
    "packages/cf-rest/src",
    "apps/every-app-gateway/src",
    "starter/src",
  ]) {
    walk(dir);
  }
  return texts.join("\n");
}

/**
 * Names on the pages that are in neither this repository's code nor the
 * built-in tools, on purpose: OpenCRM's own setting, Cloudflare's local
 * Hyperdrive variable for a binding named HYPERDRIVE, the dev cookie, and
 * the workspace tools' prefix.
 */
const NAMED_ELSEWHERE = new Set([
  "TOKEN_ENCRYPTION_KEY",
  "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
  "everyapp_dev_anon",
  "everyapp_workspace_",
]);

describe("the names the hand-written pages give", () => {
  it("are codes, settings and built-in tools the code still has", () => {
    const inventory = codeInventory();
    const codes = new Set([
      ...inventory.errors.keys(),
      ...inventory.warnings.keys(),
      ...inventory.reporter,
      ...inventory.argument,
      ...inventory.status,
      ...inventory.registry,
      ...inventory.hostedApi.keys(),
    ]);
    expect(codes.size, "the code inventory read the source").toBeGreaterThan(100);
    const tools = new Set(listBuiltinTools().map((tool) => tool.name));
    const source = sourceText();
    // cli.md is generated from the commands. The skills cite apps' and other
    // services' own codes, so only their everyapp_* tool names are checked.
    const pages = slugs()
      .filter((slug) => slug !== "cli")
      .map((slug) => ({ where: `landing-page/content/agent/${slug}.md`, text: readPage(slug), codes: true }));
    for (const dir of ["packages/cli/skills/everyapp", "packages/cli/skills/everyapp/setup", "packages/cli/skills/build-every-app"]) {
      for (const name of readdirSync(at(dir)).filter((file) => file.endsWith(".md"))) {
        const where = posix.join(dir, name);
        pages.push({ where, text: readFileSync(at(where), "utf8"), codes: false });
      }
    }
    const stale: string[] = [];
    for (const page of pages) {
      const seen = new Set<string>();
      const report = (name: string) => {
        if (NAMED_ELSEWHERE.has(name) || seen.has(name)) return;
        seen.add(name);
        stale.push(`${page.where} ${name}`);
      };
      if (page.codes) {
        for (const span of backticked(page.text)) {
          for (const name of span.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []) {
            if (!codes.has(name) && !source.includes(name)) report(name);
          }
        }
      }
      for (const name of page.text.match(/\beveryapp_[a-z0-9_]+/g) ?? []) {
        if (!tools.has(name)) report(name);
      }
    }
    expect(
      stale,
      "codes, settings or everyapp_* tools the pages name that the code no longer has: rename or remove them there, or add a deliberate exception to NAMED_ELSEWHERE",
    ).toEqual([]);
  });
});

describe("the everyapp skill", () => {
  it("points agents at the agent docs", () => {
    const skill = readFileSync(at("packages/cli/skills/everyapp/SKILL.md"), "utf8");
    expect(skill).toContain("https://everyapp.com/llms.txt");
  });
});
