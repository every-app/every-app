/** `everyapp docs`: the site's page when it answers, else the bundled copy, saying so; the list; a page that isn't there. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledSource, directorySource, docs, pageSlug } from "./index";

let dir: string;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-docs-"));
  fs.mkdirSync(path.join(dir, "setup"));
  fs.writeFileSync(path.join(dir, "index.md"), '---\ntitle: Docs for coding agents\ndescription: "Start here."\n---\n\nThe home page.\n');
  fs.writeFileSync(path.join(dir, "manifest.md"), "---\ntitle: The manifest\ndescription: Every field.\n---\n\nThe fields.\n");
  fs.writeFileSync(path.join(dir, "setup", "index.md"), "---\ntitle: Driving setup\ndescription: Setup.\n---\n\nSetup.\n");
  fs.writeFileSync(path.join(dir, "setup", "openrouter.md"), "---\ntitle: OpenRouter for the Gateway\ndescription: The key.\n---\n\nThe steps.\n");
  lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const last = () => JSON.parse(lines.at(-1)!) as { type: string; code?: string; data: Record<string, unknown> };

describe("pageSlug", () => {
  it("takes a slug, a path, a URL or a .md and gives the slug", () => {
    expect(pageSlug("manifest")).toBe("manifest");
    expect(pageSlug("setup/openrouter.md")).toBe("setup/openrouter");
    expect(pageSlug("https://everyapp.com/docs/agent/setup/openrouter.md#steps")).toBe("setup/openrouter");
    expect(pageSlug("/docs/agent/errors")).toBe("errors");
    expect(pageSlug("setup/index.md")).toBe("setup");
    expect(pageSlug("https://everyapp.com/docs/agent")).toBe("");
  });
});

describe("everyapp docs", () => {
  it("prints the site's page when the site answers", async () => {
    const fetcher = vi.fn(async () => "# The manifest (https://everyapp.com/docs/agent/manifest)\n\nLive.\n");
    await docs({ json: true }, "manifest", directorySource(dir, null), fetcher);
    expect(fetcher).toHaveBeenCalledWith("https://everyapp.com/docs/agent/manifest.md");
    expect(last()).toMatchObject({ type: "done", data: { page: "manifest", source: "site", markdown: expect.stringContaining("Live.") } });
  });

  it("falls back to the bundled copy, served like the site's and saying so", async () => {
    await docs({ json: true }, "setup/openrouter", directorySource(dir, null), async () => undefined);
    const done = last();
    expect(done.data).toMatchObject({ page: "setup/openrouter", source: "bundled" });
    expect(done.data["markdown"]).toBe("# OpenRouter for the Gateway (https://everyapp.com/docs/agent/setup/openrouter)\n\nThe steps.\n");
  });

  it("never fetches with --offline, and reads a folder's index as the folder", async () => {
    const fetcher = vi.fn(async () => "never");
    await docs({ json: true, offline: true }, "setup", directorySource(dir, null), fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(last().data).toMatchObject({ page: "setup", source: "bundled", markdown: expect.stringContaining("Driving setup") });
  });

  it("lists the pages with no page named", async () => {
    await docs({ json: true }, undefined, directorySource(dir, null));
    expect((last().data["pages"] as Array<{ page: string }>).map((entry) => entry.page)).toEqual(["", "manifest", "setup", "setup/openrouter"]);
  });

  it("refuses a page neither the site nor the bundle has, and a path out of the docs", async () => {
    for (const page of ["nope", "../secrets"]) {
      lines = [];
      await docs({ json: true }, page, directorySource(dir, null), async () => null);
      expect(last()).toMatchObject({ type: "error", code: "DOCS_PAGE_NOT_FOUND" });
    }
  });
});

describe("the bundled copy in this checkout", () => {
  it("has every setup guide the skill points at, and the security page", () => {
    const source = bundledSource();
    for (const page of ["index", "manifest", "setup", "setup/guides", "setup/openrouter", "setup/providers", "build", "patterns", "tools", "security-review", "repo/threat-model"]) {
      expect(source.file(pageSlug(page)), page).not.toBeNull();
    }
  });
});
