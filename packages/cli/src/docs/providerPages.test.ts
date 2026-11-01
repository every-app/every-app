/**
 * The provider pages of the user docs (landing-page/content/docs/providers)
 * against the catalog, the OAuth presets and the sign-in providers they are
 * generated from, and the agent page providers.md's table of them. To
 * regenerate:
 *
 *   pnpm -C packages/cli docs:update
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProviderSpec } from "@every-app/sdk/internal";
import { UPDATE_DOCS, AGENT_DOCS_DIR, readPage, writePage } from "./pages";
import { withBlock } from "./providersCatalog";
import {
  HAND_WRITTEN_PROVIDER_PAGES,
  PROVIDER_REQUEST_TEMPLATE,
  providerCompanies,
  providerPages,
  providerPagesTable,
} from "./providerPages";

const DIR = fileURLToPath(new URL("../docs/providers/", AGENT_DOCS_DIR));
const STALE = "is out of date with the provider catalog: run `pnpm -C packages/cli docs:update` and commit the result";

describe("the provider pages", () => {
  const generated = providerPages();

  it("are what the catalog generates, and nothing else is in the folder", () => {
    if (UPDATE_DOCS) {
      mkdirSync(DIR, { recursive: true });
      for (const name of readdirSync(DIR)) {
        if (!generated.has(name) && !(HAND_WRITTEN_PROVIDER_PAGES as readonly string[]).includes(name)) rmSync(`${DIR}${name}`);
      }
      for (const [name, content] of generated) {
        if (!existsSync(`${DIR}${name}`) || readFileSync(`${DIR}${name}`, "utf8") !== content) writeFileSync(`${DIR}${name}`, content);
      }
      return;
    }
    for (const [name, content] of generated) {
      expect(existsSync(`${DIR}${name}`), `providers/${name} is missing: run \`pnpm -C packages/cli docs:update\``).toBe(true);
      expect(readFileSync(`${DIR}${name}`, "utf8"), `providers/${name} ${STALE}`).toBe(content);
    }
    const extra = readdirSync(DIR).filter(
      (name) => !generated.has(name) && !(HAND_WRITTEN_PROVIDER_PAGES as readonly string[]).includes(name),
    );
    expect(extra, `pages for providers the catalog no longer has: run \`pnpm -C packages/cli docs:update\``).toEqual([]);
  });

  it("has the hand-written pages and the issue form they link", () => {
    for (const name of HAND_WRITTEN_PROVIDER_PAGES) expect(existsSync(`${DIR}${name}`), `providers/${name}`).toBe(true);
    const template = fileURLToPath(new URL(`../../../.github/ISSUE_TEMPLATE/${PROVIDER_REQUEST_TEMPLATE}`, AGENT_DOCS_DIR));
    expect(existsSync(template), `.github/ISSUE_TEMPLATE/${PROVIDER_REQUEST_TEMPLATE}`).toBe(true);
  });

  it("custom.mdx's example spec is one `everyapp provider add` takes", () => {
    const page = readFileSync(`${DIR}custom.mdx`, "utf8");
    const json = page.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(json, "custom.mdx has a json example").toBeDefined();
    const parsed = parseProviderSpec(JSON.parse(json!));
    expect(parsed.ok ? [] : parsed.problems, "custom.mdx's spec").toEqual([]);
  });

  it("gives every company a page with a way to connect it", () => {
    for (const company of providerCompanies()) {
      expect(
        company.keys.length + company.clients.length + (company.service ? 1 : 0) + (company.signIn ? 1 : 0),
        company.slug,
      ).toBeGreaterThan(0);
    }
  });

  it("has the table on the agent page providers.md", () => {
    const page = readPage("providers");
    const updated = withBlock(page, "provider-pages", providerPagesTable());
    expect(updated, "providers.md has no provider-pages block").not.toBeNull();
    if (UPDATE_DOCS) {
      if (updated !== page) writePage("providers", updated!);
      return;
    }
    expect(page, `providers.md's provider-pages block ${STALE}`).toBe(updated);
  });
});
