// The window's first chunk holds Root and Home only; every other page is a lazy route. Checked on
// the source, since importing the pages needs the preload bridge.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "../src/renderer/src");
const router = readFileSync(join(src, "router.tsx"), "utf8");

describe("renderer route split", () => {
  it("statically imports only Root and Home", () => {
    const pages = [...router.matchAll(/^import .* from "\.\/pages\/(\w+)";$/gm)].map((m) => m[1]);
    expect(pages.sort()).toEqual(["Home", "Root"]);
  });

  it("loads every other route lazily, from a module that defines it", () => {
    // One entry per `const x = createRoute(...)` declaration: its path and its lazy import, if any.
    const routes = router
      .split(/\nconst /)
      .filter((block) => block.includes("createRoute("))
      .map((block) => ({
        path: /path: "([^"]+)"/.exec(block)?.[1],
        lazy: /\.lazy\(\(\) =>\s*import\("\.\/routes\/([\w.]+)"\)\.then\(\(m\) => m\.(\w+)\)/.exec(block),
      }));
    expect(routes.filter((r) => !r.lazy).map((r) => r.path)).toEqual(["/"]);
    const lazy = routes.filter((r) => r.lazy).map((r) => [r, r.path, r.lazy![1], r.lazy![2]] as const);
    const paths = lazy.map((m) => m[1]).sort();
    expect(paths).toEqual(["/folders/$id", "/meetings/$id", "/search", "/settings", "/shared", "/templates", "/upcoming/$eventId"]);
    for (const [, path, file, name] of lazy) {
      const module = readFileSync(join(src, "routes", `${file}.tsx`), "utf8");
      expect(module, `${file} defines ${name} for ${path}`).toMatch(new RegExp(`export const ${name} = createLazyRoute\\("${path!.replace(/\$/g, "\\$")}"\\)`));
    }
  });

  it("keeps lazy modules lazy: nothing eager imports routes/", () => {
    for (const file of ["main.tsx", "router.tsx", "pages/Root.tsx", "pages/Home.tsx"]) {
      const text = readFileSync(join(src, file), "utf8");
      expect(text).not.toMatch(/^import .* from "\.{1,2}\/routes\//m);
    }
    expect(readdirSync(join(src, "routes")).every((f) => f.endsWith(".lazy.tsx"))).toBe(true);
  });
});
